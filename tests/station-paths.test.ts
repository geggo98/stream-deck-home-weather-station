import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultDataDir } from "../src/adapter/station/paths.ts";

describe("defaultDataDir", () => {
	it("macOS", () => {
		assert.equal(defaultDataDir({ platform: "darwin", home: "/Users/someone", env: {} }), "/Users/someone/Library/Application Support/home-weather-station");
	});
	it("Windows uses %APPDATA%, with a fallback", () => {
		assert.equal(defaultDataDir({ platform: "win32", home: "C:\\Users\\someone", env: { APPDATA: "C:\\Users\\someone\\AppData\\Roaming" } }), "C:\\Users\\someone\\AppData\\Roaming\\home-weather-station");
		assert.equal(defaultDataDir({ platform: "win32", home: "C:\\Users\\someone", env: {} }), "C:\\Users\\someone\\AppData\\Roaming\\home-weather-station");
	});
	it("Linux honours an absolute XDG_CONFIG_HOME and ignores a relative one", () => {
		assert.equal(defaultDataDir({ platform: "linux", home: "/home/someone", env: { XDG_CONFIG_HOME: "/xdg" } }), "/xdg/home-weather-station");
		assert.equal(defaultDataDir({ platform: "linux", home: "/home/someone", env: { XDG_CONFIG_HOME: "relative/dir" } }), "/home/someone/.config/home-weather-station");
		assert.equal(defaultDataDir({ platform: "linux", home: "/home/someone", env: {} }), "/home/someone/.config/home-weather-station");
	});
});
