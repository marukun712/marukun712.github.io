import lume from "lume/mod.ts";

const site = lume({
	src: "./src",
});
site.add("global.css");

export default site;
