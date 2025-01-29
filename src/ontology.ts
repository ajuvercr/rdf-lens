import {
    createTermNamespace,
    createUriAndTermNamespace,
    Namespace,
} from "@treecg/types";
import { NamedNode } from "@rdfjs/types";

export const RDFS = createTermNamespace(
    "http://www.w3.org/2000/01/rdf-schema#",
    "subClassOf",
) as Namespace<string[], NamedNode, string>;

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
    "oneOrMorePath",
    "zeroOrOnePath",
    "inversePath",
    "minCount",
    "maxCount",
    "datatype",
) as Namespace<string[], NamedNode, string>;

export const RDFL = createUriAndTermNamespace(
    "https://w3id.org/rdf-lens/ontology#",
    "CBD",
    "PathLens",
    "Context",
    "TypedExtract",
    "EnvVariable",
    "envKey",
    "envDefault",
    "datatype",
) as Namespace<string[], string, string> & {
    terms: Namespace<string[], NamedNode, string>;
};
