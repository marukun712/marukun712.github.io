export const layout = "layout.vto";

export const metas = {
	site: "maril.blue",
	type: "website",
	lang: "ja",
	description: "marilの個人サイト",
	title: (data: Lume.Data) => data.basename || "maril.blue",
};
