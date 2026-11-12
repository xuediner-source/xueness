/**
 * DeepSeek Harness plugin entry: the DSH package type of the host's general package import.
 *
 * `importer.ts` adapts the declarative package library (`library.ts`, built on `loader.ts` and
 * `registry.ts`) to the import registry, and `cordis-plugin.ts` recognises published DSH code
 * plugins so the import surface can decline them with the reason. Nothing from a package is
 * imported as code, evaluated or executed.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export * from "./cordis-plugin.ts";
export * from "./importer.ts";
export * from "./library.ts";
export * from "./loader.ts";
export * from "./registry.ts";

/** The bundled plugin: manifest plus an empty apply. The host registers the importer with the import registry. */
export const deepseekHarness: BundledPlugin = { manifest, plugin: definePlugin({ name: "deepseek_harness", apply() {} }) };
