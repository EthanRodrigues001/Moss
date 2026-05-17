declare module "citation-js" {
  type CiteInstance = {
    data?: Record<string, unknown>[];
    format: (type: string, options?: Record<string, unknown>) => string;
  };

  type CiteConstructor = {
    new (input: unknown): CiteInstance;
    async: (input: unknown, options?: Record<string, unknown>) => Promise<CiteInstance>;
  };

  const Cite: CiteConstructor;
  export default Cite;
}
