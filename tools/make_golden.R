# Golden results for rc-web: the only use of R in this repo, development only.
#
# Runs the rc2 reference package (and reads the reference fixtures shipped with
# it) and exports JSON to test/golden/ for the Vitest parity tests (tolerance 1e-10).
#
#   RC2_DIR=/path/to/rc2/sources Rscript tools/make_golden.R   # from the repo root
#
# Needs: pkgload, jsonlite, and the rc2 sources (RC2_DIR is required).
suppressMessages(library(jsonlite))

rc2 <- Sys.getenv("RC2_DIR")
if (!nzchar(rc2)) stop("Set RC2_DIR to the folder with the rc2 package sources.")
rc2 <- normalizePath(rc2, winslash = "/")
# load the package from source, so the golden values come from the current rc2 code
suppressMessages(pkgload::load_all(rc2, quiet = TRUE))
# the reference package name comes from its DESCRIPTION; its original package has the
# same name without the trailing digit, which is also the value of its upstream-distance option
pkg_name <- unname(read.dcf(file.path(rc2, "DESCRIPTION"), fields = "Package")[1, 1])
ref_name <- sub("[0-9]+$", "", pkg_name)
fx_dir <- file.path(rc2, "tests", "testthat", "fixtures")
fixture <- function(pattern) {
  f <- list.files(fx_dir, pattern = pattern, full.names = TRUE)
  if (length(f) != 1) stop("expected exactly one fixture matching ", pattern, " in ", fx_dir)
  f
}
out_dir <- file.path("test", "golden")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
`%||%` <- function(a, b) if (is.null(a)) b else a
compat_spec <- utils::getFromNamespace("compat_spec", pkg_name)
# distance convention: the reference calls it by its package name, the web app says "upstream"
distance_name <- function(x) if (identical(x, ref_name)) "upstream" else x
meta_json <- function(m) {
  names(m)[names(m) == ref_name] <- "ref_version"
  lapply(m, unbox)
}

write_json_file <- function(x, name) {
  path <- file.path(out_dir, name)
  write(toJSON(x, auto_unbox = FALSE, na = "null", digits = I(17), null = "null", force = TRUE), path)
  cat(sprintf("wrote %s (%.1f KB)\n", path, file.size(path) / 1024))
}

# data frame -> list of columns; NA -> null
cols <- function(df) {
  df <- as.data.frame(df, stringsAsFactors = FALSE)
  out <- lapply(df, function(x) if (is.factor(x)) as.character(x) else unname(x))
  names(out) <- names(df)
  out
}

# reference-style arguments (as stored in the fixtures) -> native specification
defaults <- list(
  weight = "length", nodes_id = "name", index_type = "full", index_mode = "to",
  c_ij_flag = TRUE, B_ij_flag = TRUE, dir_fragmentation_type = "symmetric",
  pass_confluence = 1, pass_u = "pass_u", pass_d = "pass_d", field_B = "length",
  dir_distance_type = "symmetric", disp_type = "exponential",
  param_u = NULL, param_d = NULL, param = NULL, param_l = NULL, distance = ref_name
)
native <- function(args) {
  a <- modifyList(defaults, args)
  spec <- compat_spec(a$c_ij_flag, a$B_ij_flag, a$dir_fragmentation_type, a$pass_confluence,
                      a$pass_u, a$pass_d, a$field_B, a$dir_distance_type, a$disp_type,
                      a$param_u, a$param_d, a$param, a$param_l, a$distance, a$index_type)
  list(
    weight = a$weight, type = unbox(a$index_type), mode = unbox(a$index_mode),
    spec = list(
      connectivity = if (is.null(spec$connectivity)) NULL else list(
        direction = unbox(spec$connectivity$direction), pass_u = unbox(spec$connectivity$pass_u),
        pass_d = unbox(spec$connectivity$pass_d),
        pass_confluence = unbox(spec$connectivity$pass_confluence)
      ),
      dispersal = if (is.null(spec$dispersal)) NULL else list(
        kernel = unbox(spec$dispersal$kernel), direction = unbox(spec$dispersal$direction),
        par = unname(spec$dispersal$par), field = unbox(spec$dispersal$field),
        distance = unbox(distance_name(spec$dispersal$distance))
      )
    )
  )
}

# ---- 1. random trees (reference values) -----------------
rnd <- readRDS(fixture("_random[.]rds$"))
trees <- lapply(rnd$trees, function(t) list(nodes = cols(t$nodes), edges = cols(t$edges)))
index_cases <- lapply(seq_len(nrow(rnd$results)), function(r) {
  tree_id <- rnd$results$tree_id[r]
  case_id <- rnd$results$case_id[r]
  a <- rnd$cases$args[[case_id]]
  want <- rnd$results$value[[r]]
  c(list(tree = unbox(tree_id - 1L), case = unbox(case_id)), native(a),
    list(expected = list(names = names(want), values = unname(as.numeric(want)))))
})
dindex_cases <- lapply(seq_len(nrow(rnd$dindex)), function(r) {
  a <- rnd$dcases$args[[rnd$dindex$case_id[r]]]
  a$index_type <- a$index_type %||% "full"
  c(list(tree = unbox(rnd$dindex$tree_id[r] - 1L)), native(a),
    list(barriers = cols(rnd$dindex$barriers[[r]]), expected = cols(rnd$dindex$value[[r]])))
})
write_json_file(list(meta = meta_json(rnd$meta), trees = trees, index = index_cases,
                     dindex = dindex_cases), "random.json")

# ---- 2. Ebro tutorial network (reference values) -------------------
eb <- readRDS(fixture("ebro_tutorial[.]rds$"))
eb_reach <- lapply(names(eb$reach_args), function(k) {
  c(list(case = unbox(k)), native(eb$reach_args[[k]]), list(expected = cols(eb$reach[[k]])))
})
eb_prior <- lapply(names(eb$prior_args), function(k) {
  c(list(case = unbox(k)), native(eb$prior_args[[k]]),
    list(expected = cols(eb$prior[[k]])))
})
write_json_file(list(meta = meta_json(eb$meta), nodes = cols(eb$nodes), edges = cols(eb$edges),
                     barriers = cols(eb$barriers), reach = eb_reach, prior = eb_prior),
                "ebro_tutorial.json")

# ---- 3. Ebro pipeline: geoprocessing stages and native indices ---------------
src <- file.path(rc2, "inst", "extdata", "ebro.gpkg")
sq <- function(geo, sql) tibble::as_tibble(DBI::dbGetQuery(geo$con, sql))
geo <- rc_geo_rivers(src, layer = "rivers")
st <- list()
st$rivers <- list(
  crs_m = unbox(geo$crs_m),
  n = unbox(sq(geo, "SELECT count(*) n FROM rc_reaches")$n),
  total_km = unbox(sq(geo, "SELECT sum(rc_length_km) s FROM rc_reaches")$s),
  outlets = unbox(sq(geo, "SELECT count(*) n FROM rc_reaches WHERE rc_down IS NULL")$n),
  reaches = cols(sq(geo, "SELECT rc_id, rc_down, rc_length_km, rc_upland, rc_order FROM rc_reaches ORDER BY rc_id"))
)
geo <- rc_geo_prune(geo, min_upland = 80)
st$prune <- list(
  n = unbox(sq(geo, "SELECT count(*) n FROM rc_reaches")$n),
  outlets = unbox(sq(geo, "SELECT count(*) n FROM rc_reaches WHERE rc_down IS NULL")$n),
  ids = sort(sq(geo, "SELECT rc_id FROM rc_reaches")$rc_id)
)
geo <- rc_geo_merge_chains(geo)
st$merge <- list(
  chains = cols(sq(geo, "SELECT chain_id, down_chain, n_reaches, chain_length_km, ST_NPoints(geom) AS npoints,
                               ST_Length_Spheroid(ST_FlipCoordinates(geom)) AS length_m
                         FROM rc_chains ORDER BY chain_id"))
)
geo <- rc_geo_barriers(geo, src, layer = "dams", id = "dam_id", pass_u = 0.1, pass_d = 0.8)
st$barriers <- list(n = unbox(sq(geo, "SELECT count(*) n FROM rc_barriers")$n),
                    ids = sort(sq(geo, "SELECT bar_id FROM rc_barriers")$bar_id))
geo <- rc_geo_snap(geo, max_dist = 1000)
st$snap <- list(snap = cols(sq(geo, "SELECT bar_id, chain_id, dist_m, len_m, frac, frac_ll, along, position, status
                                      FROM rc_snap ORDER BY bar_id")))
geo <- rc_geo_split(geo)
st$split <- list(
  nodes = cols(sq(geo, "SELECT node_id, piece, f0, f1, length_m, length_attr_km, ST_NPoints(geom) AS npoints
                        FROM rc_nodes ORDER BY node_id")),
  edges = cols(sq(geo, "SELECT * FROM rc_edges ORDER BY \"from\", \"to\""))
)
net <- rc_geo_build(geo)
chk <- rc_checks(geo)
st$checks <- lapply(seq_len(nrow(chk)), function(i) {
  list(stage = unbox(chk$stage[i]), check = unbox(chk$check[i]), severity = unbox(chk$severity[i]),
       n = unbox(chk$n[i]), ids = chk$ids[[i]])
})
net <- rc_set_weights(net,
  hsi_low = exp(-rc_upland / 50000), hsi_high = 1 - exp(-rc_upland / 50000),
  wul_low = hsi_low * length, wul_high = hsi_high * length)
st$build <- list(
  n_nodes = unbox(length(net$ids)), n_edges = unbox(nrow(net$edges)),
  n_dams = unbox(sum(net$edges$type == "dam")), n_networks = unbox(length(unique(net$topo$root_of))),
  total_length_km = unbox(sum(net$nodes$length)),
  nodes = cols(net$nodes[c("node_id", "length", "rc_upland", "UPLAND_SKM", "hsi_low", "hsi_high",
                           "wul_low", "wul_high")]),
  edges = cols(net$edges[c("from", "to", "type", "id_barrier", "pass_u", "pass_d")])
)

spec_json <- function(conn, disp) {
  list(
    connectivity = if (is.null(conn)) NULL else list(
      direction = unbox(conn$direction), pass_u = unbox(conn$pass_u),
      pass_d = unbox(conn$pass_d), pass_confluence = unbox(conn$pass_confluence)),
    dispersal = if (is.null(disp)) NULL else list(
      kernel = unbox(disp$kernel), direction = unbox(disp$direction), par = unname(disp$par),
      field = unbox(disp$field), distance = unbox(distance_name(disp$distance)))
  )
}
sym <- rc_connectivity("symmetric")
asym <- rc_connectivity("asymmetric")
exp95 <- rc_dispersal_exponential(0.95)
exp_asym <- rc_dispersal_exponential(param_u = 0.9, param_d = 0.97)
thr <- rc_dispersal_threshold(25)
thr_asym <- rc_dispersal_threshold(param_u = 5, param_d = 40)
lep <- rc_dispersal_leptokurtic(sigma_stat = 5, sigma_mob = 40, p = 0.6)
mid <- rc_dispersal_exponential(0.95, distance = "midpoint")

index_defs <- list(
  dci_sym = list(conn = sym, disp = NULL, type = "full", mode = "to", weight = "length"),
  dci_asym = list(conn = asym, disp = NULL, type = "full", mode = "to", weight = "length"),
  dci_reach_sym = list(conn = sym, disp = NULL, type = "reach", mode = "from", weight = "length"),
  dci_reach_asym_to = list(conn = asym, disp = NULL, type = "reach", mode = "to", weight = "length"),
  pci_exp = list(conn = sym, disp = exp95, type = "full", mode = "to", weight = "length"),
  pci_exp_reach_asym = list(conn = asym, disp = exp95, type = "reach", mode = "from", weight = "length"),
  pci_exp_asym_kernel = list(conn = asym, disp = exp_asym, type = "full", mode = "to", weight = "length"),
  pci_midpoint = list(conn = sym, disp = mid, type = "full", mode = "to", weight = "length"),
  multi_weights = list(conn = asym, disp = NULL, type = "full", mode = "to", weight = c("wul_low", "wul_high")),
  multi_weights_pci = list(conn = asym, disp = exp95, type = "reach", mode = "from",
                           weight = c("wul_low", "wul_high")),
  thr_full = list(conn = sym, disp = thr, type = "full", mode = "to", weight = "length"),
  thr_reach_from = list(conn = asym, disp = thr, type = "reach", mode = "from", weight = c("length", "wul_low")),
  thr_asym_reach_to = list(conn = asym, disp = thr_asym, type = "reach", mode = "to", weight = "length"),
  lep_full = list(conn = asym, disp = lep, type = "full", mode = "to", weight = "length"),
  lep_reach_from = list(conn = sym, disp = lep, type = "reach", mode = "from", weight = "wul_high"),
  barrier_free_pci = list(conn = NULL, disp = exp95, type = "full", mode = "to", weight = "length"),
  cafi_sym = list(conn = sym, disp = NULL, type = "sum", mode = "to", weight = c("length", "wul_low")),
  cafi_asym_from = list(conn = asym, disp = NULL, type = "sum", mode = "from", weight = "length")
)
index_out <- lapply(names(index_defs), function(nm) {
  d <- index_defs[[nm]]
  res <- rc_index(net, weight = d$weight, type = d$type, mode = d$mode,
                  connectivity = d$conn, dispersal = d$disp, threads = 1)
  c(list(case = unbox(nm), weight = d$weight, type = unbox(d$type), mode = unbox(d$mode)),
    list(spec = spec_json(d$conn, d$disp), expected = cols(res)))
})

all_bar <- unique(stats::na.omit(net$edges$id_barrier))
bars_full <- data.frame(id_barrier = all_bar, pass_u_updated = 1, pass_d_updated = 1)
set.seed(42)
bars_part <- data.frame(id_barrier = all_bar, pass_u_updated = round(runif(length(all_bar), 0.3, 1), 3),
                        pass_d_updated = round(runif(length(all_bar), 0.5, 1), 3))
bars_few <- bars_full[1:8, ]
dindex_defs <- list(
  full_dci_sym = list(conn = sym, disp = NULL, type = "full", mode = "to", weight = "length", bars = bars_full),
  full_dci_asym_partial = list(conn = asym, disp = NULL, type = "full", mode = "to", weight = "length", bars = bars_part),
  full_pci_multi_weights = list(conn = asym, disp = exp95, type = "full", mode = "to",
                                weight = c("wul_low", "wul_high"), bars = bars_full),
  full_pci_exp_asym = list(conn = asym, disp = exp_asym, type = "full", mode = "to", weight = "length", bars = bars_part),
  full_midpoint = list(conn = sym, disp = mid, type = "full", mode = "to", weight = "length", bars = bars_full),
  reach_dci_from = list(conn = asym, disp = NULL, type = "reach", mode = "from", weight = "length", bars = bars_few),
  reach_pci_to = list(conn = asym, disp = exp95, type = "reach", mode = "to", weight = c("length", "wul_low"), bars = bars_few),
  full_thr = list(conn = sym, disp = thr, type = "full", mode = "to", weight = "length", bars = bars_full),
  full_lep_multi = list(conn = asym, disp = lep, type = "full", mode = "to",
                        weight = c("length", "wul_high"), bars = bars_part),
  reach_thr_from = list(conn = asym, disp = thr, type = "reach", mode = "from", weight = "length", bars = bars_few),
  sum_sym = list(conn = sym, disp = NULL, type = "sum", mode = "to", weight = "length", bars = bars_full),
  sum_asym = list(conn = asym, disp = NULL, type = "sum", mode = "from", weight = c("length", "wul_low"), bars = bars_part)
)
dindex_out <- lapply(names(dindex_defs), function(nm) {
  d <- dindex_defs[[nm]]
  res <- rc_dindex(net, d$bars, weight = d$weight, type = d$type, mode = d$mode,
                   connectivity = d$conn, dispersal = d$disp, threads = 1)
  res <- res[setdiff(names(res), c("num_bl"))]
  c(list(case = unbox(nm), weight = d$weight, type = unbox(d$type), mode = unbox(d$mode)),
    list(spec = spec_json(d$conn, d$disp), barriers = cols(d$bars), expected = cols(res)))
})
write_json_file(list(stages = st, index = index_out, dindex = dindex_out), "ebro_pipeline.json")
cat("done\n")
