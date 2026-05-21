// @ts-check
import { defineConfig } from 'astro/config';
import rehypeExternalLinks from 'rehype-external-links';
import netlify from '@astrojs/netlify';
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';

let sitemapIntegration = [];

try {
  const { default: sitemap } = await import('@astrojs/sitemap');
  sitemapIntegration = [sitemap()];
} catch {
  // Keep dev/build working even if sitemap dependency has not been installed locally yet.
  sitemapIntegration = [];
}

// https://astro.build/config
export default defineConfig({
  site: 'https://xzsj.netlify.app',
  output: 'static',
  adapter: netlify(),
  integrations: sitemapIntegration,
  markdown: {
    rehypePlugins: [
      [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]
    ]
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      fs: {
        // Allow dev server to load deps from the main repo root when using a symlinked node_modules.
        allow: [
          process.cwd(),
          path.resolve(process.cwd(), '../../node_modules'),
        ],
      },
    },
  }
});
