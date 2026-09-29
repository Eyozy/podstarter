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
