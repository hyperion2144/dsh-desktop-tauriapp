import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "spike-cef",
		identifier: "spike.cef.dshr",
		version: "0.0.1",
	},
	build: {
		// Q8 定案：stable 2.0.2 默认 cottontail，必须显式选 bun
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
		},
		// 渲染一律不用系统 webview
		mac: { bundleCEF: true, defaultRenderer: "cef" },
		linux: { bundleCEF: true, defaultRenderer: "cef" },
		win: { bundleCEF: true, defaultRenderer: "cef" },
	},
} satisfies ElectrobunConfig;
