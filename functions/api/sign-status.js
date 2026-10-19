import { handleSignStatus } from "./_lib.js";

export async function onRequestGet(context) {
  return handleSignStatus(context.request, context.env);
}
