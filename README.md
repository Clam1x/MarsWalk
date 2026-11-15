# MarsWalk

MarsWalk is an exploratory pedestrian route planner for Mars. It accepts coordinates anywhere on the planet, compares terrain corridors, and shows the elevation source and uncertainty of each route section. It also offers mapped geology targets for science planning and estimates travel time from a user-entered walking speed.

## Run

Requires Node.js 18 or newer. Install dependencies, then run:

```sh
pnpm install
pnpm build
pnpm start
```

Open `http://127.0.0.1:4173`. Run the checks with `pnpm test`.

## Publish on GitHub Pages

Create a public GitHub repository, upload the contents of this source package (not the ZIP as a single file), and use `main` as the default branch. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**. The included workflow tests, builds, and publishes the site on each push to `main`. A project repository is served at `https://YOUR-USERNAME.github.io/REPOSITORY/`.

GitHub Free requires a public repository for Pages. The published site is public even when the repository is private on a paid plan. Do not upload the original working directory, which contains local downloads and hosting metadata.

## Terrain and imagery

- NASA MOLA MEGDR supplies the bundled global overview and preliminary routing grid: https://pds-geosciences.wustl.edu/missions/mgs/megdr.html
- USGS HRSC/MOLA Blend DEM supplies numeric heights along the global route: https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m
- USGS CTX and HiRISE stereo DTMs supply local numeric heights where valid cells support a connected route: https://stac.astrogeology.usgs.gov/docs/
- NASA Mars Trek Viking VIS, the Caltech CTX mosaic, and a public HiRISE mosaic supply image context. Images are not used as height measurements.
- USGS SIM 3292 provides regional geology context: https://pubs.usgs.gov/publication/sim3292

The global blend's 200 m output grid does not make MOLA-only terrain physically detailed at 200 m. CTX and HiRISE catalogue footprints can include missing heights. The selected walking limits, depression candidates, and route joins have not been validated against an independent set of human walking controls. This tool does not certify an EVA route.

## AI use

OpenAI Codex assisted with implementation, refactoring, tests, and documentation. The team selected the project and reviewed the results. MarsWalk does not use a trained AI model to infer terrain passability.
