export const LOCAL_PARSER_VERSION = "1.0.4";

export interface ParserAdapter {
  id: string;
  version: string;
  priority: number;
  routes: Array<{ hostname: string; pathname: string }>;
  domFeatures?: string[];
  containerHints: string[];
}
