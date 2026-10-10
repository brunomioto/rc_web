// Shared rerooting dynamic programme for multiplicative kernels.
// See dp_mult.cpp for the definitions of din, dout, uin and uout.
#ifndef RC_WEB_DP_H
#define RC_WEB_DP_H

#include <vector>

namespace rc {

struct Tree {
  const int* parent;
  const int* order;
  const int* cptr;
  const int* cidx;
  int n;
};

// Scratch buffers reused across calls by one thread.
struct DpScratch {
  std::vector<double> din, dout, uin, uout, pre_in, pre_out;
  explicit DpScratch(int n) : din(n), dout(n), uin(n), uout(n) {}
};

// Runs both passes for one weight column `w` (length n).
inline void dp_column(const Tree& t, const double* fu, const double* fd,
                      const double* w, DpScratch& s) {
  const int n = t.n;
  for (int i = n - 1; i >= 0; --i) {
    const int v = t.order[i];
    double si = w[v], so = w[v];
    for (int k = t.cptr[v]; k < t.cptr[v + 1]; ++k) {
      const int c = t.cidx[k];
      si += fd[c] * s.din[c];
      so += fu[c] * s.dout[c];
    }
    s.din[v] = si;
    s.dout[v] = so;
  }
  for (int i = 0; i < n; ++i) {
    const int p = t.order[i];
    const bool root = t.parent[p] < 0;
    if (root) {
      s.uin[p] = 0.0;
      s.uout[p] = 0.0;
    }
    const int m = t.cptr[p + 1] - t.cptr[p];
    if (m == 0) continue;
    const double base_in = w[p] + (root ? 0.0 : fu[p] * s.uin[p]);
    const double base_out = w[p] + (root ? 0.0 : fd[p] * s.uout[p]);
    s.pre_in.assign(m + 1, 0.0);
    s.pre_out.assign(m + 1, 0.0);
    for (int k = 0; k < m; ++k) {
      const int c = t.cidx[t.cptr[p] + k];
      s.pre_in[k + 1] = s.pre_in[k] + fd[c] * s.din[c];
      s.pre_out[k + 1] = s.pre_out[k] + fu[c] * s.dout[c];
    }
    double suf_in = 0.0, suf_out = 0.0;
    for (int k = m - 1; k >= 0; --k) {
      const int c = t.cidx[t.cptr[p] + k];
      s.uin[c] = base_in + (s.pre_in[k] + suf_in);
      s.uout[c] = base_out + (s.pre_out[k] + suf_out);
      suf_in += fd[c] * s.din[c];
      suf_out += fu[c] * s.dout[c];
    }
  }
}

inline double s_to(const Tree& t, const double* fd, const DpScratch& s, int v) {
  return s.dout[v] + (t.parent[v] < 0 ? 0.0 : fd[v] * s.uout[v]);
}

inline double s_from(const Tree& t, const double* fu, const DpScratch& s, int v) {
  return s.din[v] + (t.parent[v] < 0 ? 0.0 : fu[v] * s.uin[v]);
}

}  // namespace rc

#endif
