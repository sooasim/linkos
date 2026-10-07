import { living } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-032 AI Adaptive Card suggestion (labeled, owner-confirmable)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => living.adaptiveSuggest(ctx, params.id, parse(living.adaptiveInput, body)));
