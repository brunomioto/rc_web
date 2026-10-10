// WebAssembly core of rc-web: a plain C API over the rc2
// kernels (topology, rerooting DP, leave-one-out, bounded searches).
//
// Ported from rc2/src/{topology,dp_mult,loo,bounded}.cpp. The Rcpp and
// RcppParallel layers are gone: every routine works on raw buffers owned by
// the caller (matrices are column-major, like R) and runs serially. Summation
// orders are kept identical to rc2 so results agree to rounding.
#include <emscripten/emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <vector>

#include "dp.h"

namespace {

constexpr int NA_INT = -1;  // sentinel for "not reached" (R NA_integer_)

enum Kernel { THRESHOLD_SYM = 1, THRESHOLD_ASYM = 2, LEPTOKURTIC = 3 };

struct Frame {
  int node, from;
  double D, Dd, Du, C;
};

// P(Z > D / sd) for the standard normal: R::pnorm(D, 0, sd, lower = 0).
inline double upper_normal(double D, double sd) {
  return 0.5 * std::erfc(D / (sd * M_SQRT2));
}

inline rc::Tree make_tree(const int* parent, const int* order, const int* cptr,
                          const int* cidx, int n) {
  return rc::Tree{parent, order, cptr, cidx, n};
}

// Pair value B(D, Dd, Du) of the bounded kernels; -1 prunes the search.
inline double kernel_value(int kernel, const double* par, double D, double Dd,
                           double Du) {
  switch (kernel) {
    case THRESHOLD_SYM:
      return D <= par[0] ? 1.0 : -1.0;
    case THRESHOLD_ASYM:
      return (Du <= par[0] && Dd <= par[1]) ? 1.0 : -1.0;
    default: {
      const double v = 2.0 * (par[2] * upper_normal(D, par[0]) +
                              (1.0 - par[2]) * upper_normal(D, par[1]));
      return v > 0.0 ? v : -1.0;
    }
  }
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void* rc_alloc(std::size_t bytes) { return std::malloc(bytes); }
EMSCRIPTEN_KEEPALIVE void rc_free(void* p) { std::free(p); }

// Smoke test used by the spike: S_to of the last reach of a 3-reach chain.
EMSCRIPTEN_KEEPALIVE double rc_smoke() {
  const int parent[3] = {-1, 0, 1}, order[3] = {0, 1, 2};
  const int cptr[4] = {0, 1, 2, 2}, cidx[2] = {1, 2};
  const double fu[3] = {1, 0.5, 0.5}, fd[3] = {1, 0.5, 0.5}, w[3] = {1, 1, 1};
  const rc::Tree t = make_tree(parent, order, cptr, cidx, 3);
  rc::DpScratch s(3);
  rc::dp_column(t, fu, fd, w, s);
  return rc::s_to(t, fd, s, 2);
}

// Rooted-forest topology. Returns the number of reached nodes (nodes on a
// cycle are never reached), or -1 for an out-of-range parent and -2 for a node
// that is its own parent; *err_node then holds the 0-based offending node.
EMSCRIPTEN_KEEPALIVE int rc_topology(const int* parent, int n, int* order,
                                     int* child_ptr, int* child_idx, int* root_of,
                                     int* depth, int* err_node) {
  std::fill(child_ptr, child_ptr + n + 1, 0);
  for (int v = 0; v < n; ++v) {
    const int p = parent[v];
    if (p < -1 || p >= n) {
      *err_node = v;
      return -1;
    }
    if (p == v) {
      *err_node = v;
      return -2;
    }
    if (p >= 0) child_ptr[p + 1]++;
  }
  for (int v = 0; v < n; ++v) child_ptr[v + 1] += child_ptr[v];
  std::vector<int> fill(child_ptr, child_ptr + n);
  for (int v = 0; v < n; ++v) {
    if (parent[v] >= 0) child_idx[fill[parent[v]]++] = v;
  }
  std::fill(order, order + n, -1);
  std::fill(root_of, root_of + n, -1);
  std::fill(depth, depth + n, 0);
  int head = 0, tail = 0;
  for (int v = 0; v < n; ++v) {
    if (parent[v] == -1) {
      order[tail++] = v;
      root_of[v] = v;
    }
  }
  while (head < tail) {
    const int v = order[head++];
    for (int k = child_ptr[v]; k < child_ptr[v + 1]; ++k) {
      const int c = child_idx[k];
      root_of[c] = root_of[v];
      depth[c] = depth[v] + 1;
      order[tail++] = c;
    }
  }
  return tail;
}

// Unbranched chains: chain head (most downstream reach) and position along it.
EMSCRIPTEN_KEEPALIVE void rc_chains(const int* parent, const int* order,
                                    const int* child_ptr, int n, int* chain, int* pos) {
  for (int t = 0; t < n; ++t) {
    const int v = order[t];
    const int p = parent[v];
    if (p >= 0 && child_ptr[p + 1] - child_ptr[p] == 1) {
      chain[v] = chain[p];
      pos[v] = pos[p] + 1;
    } else {
      chain[v] = v;
      pos[v] = 0;
    }
  }
}

// Strahler stream order; nodes not reached from a root get -1.
EMSCRIPTEN_KEEPALIVE void rc_strahler(const int* order, const int* child_ptr,
                                      const int* child_idx, int n, int n_reached,
                                      int* so) {
  std::fill(so, so + n, NA_INT);
  for (int t = n_reached - 1; t >= 0; --t) {
    const int v = order[t];
    int best = 0, n_best = 0;
    for (int k = child_ptr[v]; k < child_ptr[v + 1]; ++k) {
      const int s = so[child_idx[k]];
      if (s > best) {
        best = s;
        n_best = 1;
      } else if (s == best) {
        ++n_best;
      }
    }
    so[v] = best == 0 ? 1 : best + (n_best > 1);
  }
}

// Linear-time sums for multiplicative kernels (see dp.h). W is n x k. The
// optional din/dout/uin/uout (n x k each) are only written when keep != 0.
EMSCRIPTEN_KEEPALIVE void rc_dp_mult(const int* parent, const int* order,
                                     const int* child_ptr, const int* child_idx,
                                     const double* fu, const double* fd,
                                     const double* W, int n, int k, int keep,
                                     double* S_to, double* S_from, double* Din,
                                     double* Dout, double* Uin, double* Uout) {
  const rc::Tree tree = make_tree(parent, order, child_ptr, child_idx, n);
  rc::DpScratch s(n);
  for (int col = 0; col < k; ++col) {
    const std::size_t off = static_cast<std::size_t>(col) * n;
    rc::dp_column(tree, fu, fd, W + off, s);
    for (int v = 0; v < n; ++v) {
      S_to[off + v] = rc::s_to(tree, fd, s, v);
      S_from[off + v] = rc::s_from(tree, fu, s, v);
      if (keep) {
        Din[off + v] = s.din[v];
        Dout[off + v] = s.dout[v];
        Uin[off + v] = s.uin[v];
        Uout[off + v] = s.uout[v];
      }
    }
  }
}

// Leave-one-out scenarios [first, last) for multiplicative kernels. Scenario b
// overrides the factors of edges bar_ptr[b]..bar_ptr[b+1]. `out` is
// n x (k * (last - first)); column ((b - first) * k + c) is scenario b, weight c.
EMSCRIPTEN_KEEPALIVE void rc_loo_mult(const int* parent, const int* order,
                                      const int* child_ptr, const int* child_idx,
                                      const double* fu, const double* fd,
                                      const double* W, int n, int k,
                                      const int* bar_ptr, const int* bar_node,
                                      const double* new_fu, const double* new_fd,
                                      int first, int last, int to, double* out) {
  const rc::Tree tree = make_tree(parent, order, child_ptr, child_idx, n);
  rc::DpScratch s(n);
  std::vector<double> lfu(fu, fu + n), lfd(fd, fd + n);
  for (int b = first; b < last; ++b) {
    for (int e = bar_ptr[b]; e < bar_ptr[b + 1]; ++e) {
      lfu[bar_node[e]] = new_fu[e];
      lfd[bar_node[e]] = new_fd[e];
    }
    for (int c = 0; c < k; ++c) {
      rc::dp_column(tree, lfu.data(), lfd.data(), W + static_cast<std::size_t>(c) * n, s);
      double* o = out + (static_cast<std::size_t>(b - first) * k + c) * n;
      for (int v = 0; v < n; ++v) {
        o[v] = to ? rc::s_to(tree, lfd.data(), s, v) : rc::s_from(tree, lfu.data(), s, v);
      }
    }
    for (int e = bar_ptr[b]; e < bar_ptr[b + 1]; ++e) {
      lfu[bar_node[e]] = fu[bar_node[e]];
      lfd[bar_node[e]] = fd[bar_node[e]];
    }
  }
}

// Sums for threshold and leptokurtic kernels: one search per source reach.
// "from" sums are accumulated per block of `block_size` sources and merged in
// block order, exactly as rc2 does. S_to / S_from are n x k and only
// touched when need_to / need_from are set (S_from must be zero-initialised
// by the caller).
EMSCRIPTEN_KEEPALIVE void rc_bounded(const int* parent, const int* child_ptr,
                                     const int* child_idx, const double* cu,
                                     const double* cd, const double* cost, int kernel,
                                     const double* par, const double* W, int n, int k,
                                     int need_to, int need_from, int block_size,
                                     double* S_to, double* S_from) {
  std::vector<Frame> queue;
  queue.reserve(64);
  std::vector<double> acc(k);
  std::vector<double> slot(need_from ? static_cast<std::size_t>(n) * k : 0);
  const int n_blocks = (n + block_size - 1) / block_size;
  for (int block = 0; block < n_blocks; ++block) {
    if (need_from) std::fill(slot.begin(), slot.end(), 0.0);
    const int s_lo = block * block_size;
    const int s_hi = std::min(n, s_lo + block_size);
    for (int s = s_lo; s < s_hi; ++s) {
      std::fill(acc.begin(), acc.end(), 0.0);
      queue.clear();
      queue.push_back({s, -1, 0.0, 0.0, 0.0, 1.0});
      for (std::size_t head = 0; head < queue.size(); ++head) {
        const Frame f = queue[head];
        const double B = kernel_value(kernel, par, f.D, f.Dd, f.Du);
        if (B < 0.0) continue;
        const double A = f.C * B;
        if (need_to) {
          for (int c = 0; c < k; ++c) acc[c] += A * W[static_cast<std::size_t>(c) * n + f.node];
        }
        if (need_from) {
          double* row = slot.data() + f.node;
          for (int c = 0; c < k; ++c) {
            row[static_cast<std::size_t>(c) * n] += W[static_cast<std::size_t>(c) * n + s] * A;
          }
        }
        // downstream neighbour (edge identified by f.node)
        const int p = parent[f.node];
        if (p >= 0 && p != f.from) {
          const double C = f.C * cd[f.node];
          if (C > 0.0) {
            queue.push_back({p, f.node, f.D + cost[f.node], f.Dd + cost[f.node], f.Du + 0.0, C});
          }
        }
        // upstream neighbours (edges identified by each child)
        for (int t = child_ptr[f.node]; t < child_ptr[f.node + 1]; ++t) {
          const int ch = child_idx[t];
          if (ch == f.from) continue;
          const double C = f.C * cu[ch];
          if (C > 0.0) {
            queue.push_back({ch, f.node, f.D + cost[ch], f.Dd + 0.0, f.Du + cost[ch], C});
          }
        }
      }
      if (need_to) {
        for (int c = 0; c < k; ++c) S_to[static_cast<std::size_t>(c) * n + s] = acc[c];
      }
    }
    if (need_from) {
      for (std::size_t i = 0; i < static_cast<std::size_t>(n) * k; ++i) S_from[i] += slot[i];
    }
  }
}

}  // extern "C"
