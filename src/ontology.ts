import { createTermNamespace, createUriAndTermNamespace } from "@treecg/types";

export const RDFS = createTermNamespace(
  "http://www.w3.org/2000/01/rdf-schema#",
  "subClassOf",
);

export const SHACL = createTermNamespace(
  "http://www.w3.org/ns/shacl#",
  // Basics
  "Shape",
  "NodeShape",
  "PropertyShape",
  // SHACL target constraints
  "targetNode",
  "targetClass",
  "targetSubjectsOf",
  "targetObjectsOf",
  // Property things
  "property",
  "path",
  "class",
  "name",
  "description",
  "defaultValue",
  // Path things
  "alternativePath",
  "zeroOrMorePath",
  "inversePath",
  "minCount",
  "maxCount",
  "datatype",
);
export const RDFL = createUriAndTermNamespace(
  "https://w3id.org/rdf-lens/ontology#",
  "CBD",
  "PathLens",
  "Context",
  "TypedExtract",
  "EnvVariable",
  "envKey",
  "envDefault"
);
