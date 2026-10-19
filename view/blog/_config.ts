import type StateInline from "npm:@types/markdown-it@14.1.2/lib/rules_inline/state_inline.d.mts";
import type MarkdownIt from "npm:markdown-it@14.1.1";
import lume from "lume/mod.ts";
import metas from "lume/plugins/metas.ts";

const site = lume({
	src: "./src",
	location: new URL("https://maril.blue"),
});
site.use(metas());
site.add("style.css");
site.add("bg.png");
site.add("image");

function wikilinkImage(md: MarkdownIt) {
	md.inline.ruler.before(
		"image",
		"wikilink_image",
		(state: StateInline, silent: boolean) => {
			const start = state.pos;
			if (state.src.slice(start, start + 3) !== "![[") {
				return false;
			}
			const end = state.src.indexOf("]]", start + 3);
			if (end === -1) {
				return false;
			}
			const filename = state.src.slice(start + 3, end).trim();
			if (!filename) {
				return false;
			}
			if (!silent) {
				const token = state.push("image", "img", 0);
				token.attrs = [
					["src", `/image/${filename}`],
					["alt", ""],
				];
				const textToken = new state.Token("text", "", 0);
				textToken.content = filename;
				token.children = [textToken];
			}
			state.pos = end + 2;
			return true;
		},
	);
}

site.hooks.markdownIt((engine: MarkdownIt) => {
	engine.use(wikilinkImage);
});

export default site;
