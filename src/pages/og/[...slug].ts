// https://github.com/delucis/astro-og-canvas/blob/latest/packages/astro-og-canvas/README.md
import { getCollection } from "astro:content";
import { OGImageRoute } from "astro-og-canvas";
import { trimRelPath, toSlug } from "@/utils/slug";
import { SITE_TITLE } from "@/config";

const entries = await getCollection("notes");

const pages = Object.fromEntries(
  entries.map((note) => {
    const path = trimRelPath(note.filePath) ?? note.id;
    const slug = toSlug(path) ?? note.id;
    const title = note.filePath
      ? note.filePath.substring(
          note.filePath.lastIndexOf("/") + 1,
          note.filePath.lastIndexOf(".")
        )
      : note.id;
    return [slug, { title }];
  })
);

export const { getStaticPaths, GET } = await OGImageRoute({
  param: "slug",
  pages,
  getImageOptions: (_, page) => ({
    title: page.title,
    description: "marilの個人サイトです。",
    fonts: ["./src/fonts/SourceHanCodeJP.ttc"],
  }),
});
