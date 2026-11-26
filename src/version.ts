import metadata from "../package.json" with { type: "json" };

// Bun substitutes the release version only when building the standalone CLI.
declare const __FRAMEOFMIND_RELEASE_VERSION__: string;
export const IS_RELEASE_BUNDLE = typeof __FRAMEOFMIND_RELEASE_VERSION__ !== "undefined";
/** The package version with no mark. Hosted Studio reports this: its deploy is its release. */
export const PACKAGE_VERSION: string = IS_RELEASE_BUNDLE ? __FRAMEOFMIND_RELEASE_VERSION__ : metadata.version;
// A version this tool prints names the code that is running. Anything that is
// not a release bundle says so, because a checkout's build can be older or
// newer than the number in package.json.
export const VERSION: string = IS_RELEASE_BUNDLE ? PACKAGE_VERSION : `${PACKAGE_VERSION}+source`;

declare const __FRAMEOFMIND_RELEASE_COMMIT__: string;
export const RELEASE_COMMIT = typeof __FRAMEOFMIND_RELEASE_COMMIT__ === "string" ? __FRAMEOFMIND_RELEASE_COMMIT__ : null;
