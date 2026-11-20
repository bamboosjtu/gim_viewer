import { parseSourceDocument, type SourceDocument } from "./sourceDocuments.js";

export interface SourceDocumentSource {
  readDocument?(path: string): Promise<SourceDocument>;
  readText(path: string): Promise<string>;
}

/**
 * One document identity per extraction.
 *
 * The promise cache is shared by CBM traversal, DEV expansion and FAM
 * materialization. A rejected read stays rejected for this extraction so a
 * malformed source cannot trigger a second archive read through another path.
 */
export class SourceDocumentReader {
  readonly documents: SourceDocument[] = [];
  private readonly cache = new Map<string, Promise<SourceDocument>>();

  constructor(private readonly source: SourceDocumentSource) {}

  document(path: string): Promise<SourceDocument> {
    let promise = this.cache.get(path);
    if (!promise) {
      promise = (
        this.source.readDocument
          ? this.source.readDocument(path)
          : this.source
              .readText(path)
              .then((text) => parseSourceDocument(path, text))
      ).then((doc) => {
        this.documents.push(doc);
        return doc;
      });
      this.cache.set(path, promise);
    }
    return promise;
  }
}
