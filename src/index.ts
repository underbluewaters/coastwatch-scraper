import * as cheerio from "cheerio";
import slugify from "slugify";
import { Feature, Point } from "geojson";

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  miles: KVNamespace;
}

type MileFeature = Feature<Point, {
  name: string;
  url: string;
  imageUrl?: string;
  numReports?: number;
  mileNumber: number;
}>;

export default {
  /**
   * scheduled()
   * Fetches data from a CoastWatch Google Spreadsheet and processes it to
   * create a feature collection of miles. Includes the mile name, URL, and
   * coordinates. Also fetches the mile image and number of reports if
   * available.
   *
   * This scheduled function is triggered by a cron job that runs every day at
   * 3am (controlled by wrangler.toml).
   *
   * @param event - The event object.
   * @param env - The environment object.
   * @param ctx - The execution context object.
   * @returns A promise that resolves when the data is processed and stored.
   */
  async scheduled(event: any, env: Env, ctx: ExecutionContext) {
    const response = await fetch(
      `https://docs.google.com/spreadsheets/d/e/2PACX-1vSp5MoqyAVhnJ62MKhBcQOWZmfs31cYbkM5Jp1yl1k2eDoa26EswGD4x_ephhuFXvYst2VgCaw3Qvau/pubhtml`
    );
    const body = await response.text();
    const $ = cheerio.load(body);
    // Start constructing a GeoJSON feature collection of miles
    const miles = {
      type: "FeatureCollection",
      updatedAt: new Date().toISOString(),
      features: [] as MileFeature[]
    }
    let imagesFetched = 0;
    // Start parsing all the rows of the html table
    for (const row of $("table tbody tr")) {
      const id = parseInt($(row).find("td:nth-child(2)").text());
      // Skip header rows
      if (isNaN(id)) {
        continue;
      }
      const name = $(row).find("td:nth-child(3)").text();
      // Not really sure what this is, but it's not a mile
      if (/never captured on OSCC website/.test(name)) {
        continue;
      }
      // Just grab the south boundary to contruct a point
      const coords = $(row).find("td:nth-child(5)").text().split(",").reverse();
      const feature: MileFeature = {
        type: "Feature",
        id,
        properties: {
          name,
          url: `https://oregonshores.org/mile/mile-${id}-${slugify(
            name.toLowerCase()
          )}/`,
          mileNumber: id,
        },
        geometry: {
          type: "Point",
          coordinates: coords.map((coord) => parseFloat(coord))
        },
      };
      // There are only 339 miles, so we can limit the number of mile-pages
      // visited. This is just a sanity check to keep the function from running
      // forever if the website changes.
      if (imagesFetched++ < 500) {
        // Fetch the mile detail page to get the image and number of reports
        const response = await fetch(feature.properties.url);
        const body = await response.text();
        const $$ = cheerio.load(body);
        // There may be a representative image on the mile page
        const imageUrl = $$("img.mile-image").attr("src");
        if (imageUrl) {
          feature.properties.imageUrl = imageUrl;
        } else {
          // As a backup, find images from volunteer submitted reports, but be
          // sure to skip over placeholder images, indicated by the alt text.
          const reportImageUrl = $$(
            "img.mile-report-result-image:not([alt*=decorative])"
          )
            .first()
            .attr("src");
          if (reportImageUrl) {
            feature.properties.imageUrl = reportImageUrl;
          }
        }
        // Try to get the number of reports from the pagination text
        const reports = $$(".results-meta .num-results p").text();
        const data = /Showing \d+ of (\d+) reports/.exec(reports);
        if (data && data[1]) {
          const numReports = parseInt(data[1]);
          if (!isNaN(numReports)) {
            feature.properties.numReports = numReports;
          }
        }
      }
      miles.features.push(feature);
    }
    // Sanity check that it looks like we got useful data from the site. If the
    // site changes, throw an exception that will hopefully be caught by 
    // monitoring of the cron workers. Even if it fails, the old data will still
    // be served from the KV store.
    if (!miles.features.find((mile) => !mile.properties.imageUrl)) {
      throw new Error(
        "No images found for any miles. Could the website have changed?"
      );
    } else if (!miles.features.find((mile) => !mile.properties.numReports)) {
      throw new Error(
        "No reports found for any miles. Could the website have changed?"
      );
    } else if (miles.features.length < 10) {
      throw new Error(
        `Only found ${miles.features.length} miles. Could the website have changed?`
      );
    }
    // Save the feature collection to the KV store
    await env.miles.put("miles", JSON.stringify(miles, null, 2));
    return;
  },
  /**
   * fetch()
   * Simply returns the feature collection of miles from KV store. Must be
   * created and updated by the scheduled function.
   * @param request
   * @param env
   * @param ctx
   * @returns
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Make sure it's a GET request
    if (request.method !== "GET") {
      return new Response("Only GET supported", { status: 403 });
    }
    const featureCollection = await env.miles.get("miles");
    if (!featureCollection) {
      return new Response("Not found. Cron job did not create dataset?", {
        status: 404,
      });
    } else {
      return new Response(featureCollection, {
        headers: {
          "content-type": "application/json",
          // 24 hour cache
          "cache-control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
  },
};
