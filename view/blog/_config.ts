import lume from "lume/mod.ts";

const site = lume({
	src: "./src",
});
site.add("style.css");
site.add("bg.png");

export default site;
