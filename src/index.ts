import * as cheerio from 'cheerio';
import slugify from 'slugify';

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  miles: KVNamespace;
}

export default {

  /**
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
    const miles: {
      id: number;
      name: string;
      northBoundary: number[];
      southBoundary: number[];
      url: string;
      imageUrl?: string;
      numReports?: number;
    }[] = [];
    let imagesFetched = 0;
    for (const row of $('table tbody tr')) {
      const id = parseInt($(row).find('td:nth-child(2)').text());
      if (isNaN(id)) {
        continue;
      }
      const name = $(row).find('td:nth-child(3)').text();
      if (/never captured on OSCC website/.test(name)) {
        continue;
      }
      let coords = $(row).find('td:nth-child(4)').text().split(',').reverse();
      const northBoundary = coords.map((coord) => parseFloat(coord));
      coords = $(row).find('td:nth-child(5)').text().split(',').reverse();
      const southBoundary = coords.map((coord) => parseFloat(coord));
      const mile = {
        id,
        name,
        northBoundary,
        southBoundary,
        url: `https://oregonshores.org/mile/mile-${id}-${slugify(name.toLowerCase())}/`,
      } as any;
      if (imagesFetched++ < 500) {
        const response = await fetch(mile.url);
        const body = await response.text();
        const $$ = cheerio.load(body);
        const imageUrl = $$('img.mile-image').attr('src');
        if (imageUrl) {
          mile.imageUrl = imageUrl;
        }
        const reports = $$('.mile-report-all-mile-reports h4:nth-of-type(1)').text();
        const data = /(\d+) Report/.exec(reports);
        if (data && data[1]) {
          const numReports = parseInt(data[1]);
          if (!isNaN(numReports)) {
            mile.numReports = numReports;
          }
        }
      }
      miles.push(mile);
    }
    const featureCollection = {
      type: 'FeatureCollection',
      features: miles.map((mile) => ({
        type: 'Feature',
        id: mile.id,
        properties: {
          name: mile.name,
          url: mile.url,
          imageUrl: mile.imageUrl,
          numReports: mile.numReports,
        },
        geometry: {
          type: 'Point',
          coordinates: mile.southBoundary,
        },
      })),
    };
    await env.miles.put('miles', JSON.stringify(featureCollection, null, 2));
    return;
  },
  /**
   * Simply returns the feature collection of miles from KV store. Must be 
   * created and updated by the scheduled function.
   * @param request 
   * @param env 
   * @param ctx 
   * @returns 
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const featureCollection = await env.miles.get('miles');
    if (!featureCollection) {
      return new Response('Not found. Cron job did not create dataset?', { status: 404 });
    } else {
      return new Response(featureCollection, {
        headers: {
          'content-type': 'application/json',
          // 24 hour cache
          'cache-control': 'public, max-age=86400',
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
  },
};
