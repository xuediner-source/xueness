/** Desktop first-launch flag. OS permission prompts stay in the desktop host. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { createOnboardingHttp, ONBOARDING_ROUTES, type OnboardingHttpOptions } from "./http.ts";

export const onboarding: BundledPlugin = { manifest, plugin: definePlugin({ name: "onboarding", apply() {} }) };
