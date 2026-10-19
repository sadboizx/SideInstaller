import { handleSign, json } from "./_lib.js";

export async function onRequest(context) {
  if (context.request.method !== "POST") return json({ error: "Use POST" }, 405);
  return handleSign(context.request, context.env);
}
