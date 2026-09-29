export interface Episode {
  id: string;
  title: string;
  link: string;
  pubDate: string;
  content: string;
  contentSnippet: string;
  enclosure: {
    url: string;
    type?: string;
    length?: string;
  };
  itunes?: {
    duration?: string;
    image?: string;
    episode?: string | number;
  };
  themeId?: string;
  tags?: string[];
  archived?: boolean;
}

export interface Theme {
  id: string;
  title: string;
  description: string;
  representativeTags?: string[];
}

export interface ResolvedPodcastResult {
  type: "rss" | "netease" | "direct";
  platform: "apple" | "ximalaya" | "netease" | "xiaoyuzhou" | "rss";
  platformUrl?: string;
  feedUrl?: string;
  headers?: Record<string, string>;
  title?: string;
  author?: string;
  description?: string;
  cover?: string;
  episodes?: Episode[];
}
