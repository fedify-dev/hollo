import {
  type Object as APObject,
  type Collection,
  type DocumentLoader,
  Link,
  traverseCollection,
} from "@fedify/vocab";

export interface IterateCollectionOptions {
  documentLoader?: DocumentLoader;
  contextLoader?: DocumentLoader;
  suppressError?: boolean;
}

export async function* iterateCollection(
  collection: Collection,
  options?: IterateCollectionOptions,
): AsyncIterable<APObject> {
  for await (const item of traverseCollection(collection, options)) {
    if (item instanceof Link) continue;
    yield item;
  }
}
