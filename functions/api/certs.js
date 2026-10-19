import { buildCerts } from "./_lib.js";

export async function onRequestGet(context) {
  const result = await buildCerts(context.request, context.env);
  return new Response(JSON.stringify(result.certs, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
  });
}
