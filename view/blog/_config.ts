import lume from "lume/mod.ts";
import metas from "lume/plugins/metas.ts";

const site = lume({
	src: "./src",
	location: new URL("https://maril.blue"),
});
// https://lume.land/plugins/metas/
site.use(metas());
site.add("style.css");
site.add("bg.png");

export default site;
