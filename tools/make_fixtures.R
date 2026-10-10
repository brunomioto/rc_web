# Small input fixtures in other formats and CRS, to test the upload paths:
# the pruned Ebro reaches as a UTM shapefile and as GeoJSON, and the dams as a CSV.
#
#   RC2_DIR=/path/to/rc2/sources Rscript tools/make_fixtures.R
suppressMessages(library(sf))
rc2 <- Sys.getenv("RC2_DIR")
if (!nzchar(rc2)) stop("Set RC2_DIR to the folder with the rc2 package sources.")
src <- file.path(rc2, "inst", "extdata", "ebro.gpkg")
out <- file.path("test", "fixtures")
dir.create(out, recursive = TRUE, showWarnings = FALSE)

rivers <- st_read(src, layer = "rivers", quiet = TRUE)
rivers <- rivers[rivers$UPLAND_SKM > 80, c("HYRIV_ID", "NEXT_DOWN", "LENGTH_KM", "UPLAND_SKM", "ORD_STRA")]
dams <- st_read(src, layer = "dams", quiet = TRUE)

# shapefile in UTM 30N (with .prj, but no EPSG authority code in it)
utm <- st_transform(rivers, 32630)
unlink(file.path(out, "ebro_rivers_utm.*"))
st_write(utm, file.path(out, "ebro_rivers_utm.shp"), quiet = TRUE)
# GeoJSON in lon/lat
unlink(file.path(out, "ebro_rivers.geojson"))
st_write(rivers, file.path(out, "ebro_rivers.geojson"), quiet = TRUE)
# dams as a plain CSV
xy <- st_coordinates(dams)
write.csv(data.frame(dam_id = dams$dam_id, lon = xy[, 1], lat = xy[, 2]),
          file.path(out, "ebro_dams.csv"), row.names = FALSE)
print(file.info(list.files(out, full.names = TRUE))[, "size", drop = FALSE])
