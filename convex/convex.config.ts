import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    MUSIR_SERVICE_SECRET: v.string(),
  },
});
