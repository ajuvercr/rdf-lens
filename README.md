# RDF-Lens

Look into a dataset with RDF-Lens.
Here the term Lens, is the same concept of Haskell lenses available in [this well known library](https://hackage.haskell.org/package/lens).

A lens looks at a point in a dataset, for RDF-Lens this usually is looking at a Term inside a store.
Lenses can be combined to from a point, look furthur inside the dataset, as long as the types allow for it.

Currently two lenses exist in RDF-Lens `BasicLens<C, T>` and `BasicLensM<C, T>` (M stands for Multiple: `BasicLensM<C, T>` is a subclass of `BasicLens<C, T[]>`). 
C stands for Container, a combination of the store and the current target. T stands for resulting type.

`BasicLens<C, T>` can be combined with `BasicLens<T, D>` and will result in `BasicLens<C, D>`.


## Examples

### Pred

A very common Lens is created with `pred` and takes in a predicate term and returns `BasicLensM<Cont, Cont>`.
So it starts pointing inside the dataset and results in pointing to multiple things inside the dataset.
Using the function `.thenFlat` another predicate can be chained to explore the dataset deper.


### Extracting data

RDF-Lens tries to make it developer friendly and typed to extract data from a RDF store.
This example shows how to extract a point with two coordinates from the data.
```typescript 
import { pred } from "rdf-lens";
import { DataFactory, Parser } from "n3";

const { namedNode } = DataFactory;

const extractX = pred(namedNode("x"))         // Follow predicate <x>
  .one()                                      // We expect only to find one term
  .map(({id}) => ({x: id.value}));            // Map that term to a Json Object
  
const extractY = pred(namedNode("y"))         // Follow predicate <y>
  .one()                                      // We expect only to find one term
  .map(({id}) => ({y: id.value}));            // Map that term to a Json Object
  
const pointLens = extractX.and(extractY)      // Combine both lenses
  .map(([{x}, {y}]) => ({x, y}));             // Map them together to a point object

const turtle = "<a> <x> 42; <y> 43.";
const quads = new Parser().parse(turtle);     // Parser quads 
const point = pointLens.execute({id: namedNode("a"), quads});  // Execute the lens over the dataset
```


### Extracting RDF list items

Extracting point data is not very exciting, this example shows how to extract all items from a RDF List.

```typescript
const RDFListElement = pred(RDF.first).one().and(pred(RDF.rest).one());

// RdfList is a Lens that takes in a Container pointing to a Term and returns a list of Terms 
const RdfList: BasicLens<Cont, Term[]> = new BasicLens((c) => {
  if (c.id.equals(RDF.nil)) {
    return [];
  }

  const [first, rest] = RDFListElement.execute(c);
  const els = RdfList.execute(rest);
  els.unshift(first.id);
  return els;
});
```

### Extracting starting from shacl shapes

Shacl shapes are used widely to constrain rdf data to some shape.
With rdf-lens you can extract data starting from a shape to a plain old javascript object.
The field names are defined by the `sh:name`, that is part of the `sh:property` object.

This examples shows how to define and extract a point.
```turtle
# The shacl shape for a point
[] a sh:NodeShape;
  sh:targetClass <Point>; # Derive a lens for js:Point
  sh:property [
    sh:name "x";             # Field x
    sh:path <x>;            # is found at path `js:x`
    sh:datatype xsd:integer; # and is an integer
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:datatype xsd:integer;
    sh:path <y>;
    sh:name "y";
    sh:maxCount 1;
    sh:minCount 1;
  ].
```

```turtle
# Data that adheres to that shape
<MyPoint> a <Point>;
  <x> 5;
  <y> 8.
```

Let's use this data to extract a point.
```typescript
const shapes = extractShapes(shapeQuads);
const quads = parseQuads(dataQuads);

const lens = shapes.lenses["Point"]; // The lens that extracts a point
const point = lens.execute({id: namedNode("MyPoint"), quads});

console.log(point); // { "x": 5, "y": 8 }
```


**Deep objects** are also supported, let's reuse the point shape to extract a line.

```turtle
[] a sh:NodeShape;
  sh:targetClass <Line>;
  sh:property [
    sh:name "start";  // The start is a point
    sh:path <start>;
    sh:class <Point>;
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:name "end";    // The end is a point
    sh:path <end>;
    sh:class <Point>;
    sh:maxCount 1;
    sh:minCount 1;
  ].
```

Note: `sh:datatype` is used for literals, `sh:class` is used for objects.

* `sh:minCount` tells rdf-lens that this property is required, and will fail to parse an object that does not adhere to the shape.
* `sh:maxCount` tells rdf-lens whether or not to expect multiple objects. If this is not set or is bigger than 1, the Javascript object will have an array as its value.



**Special implemented classes**
Sometimes a plain old javascript objects is not enough, some special classes work out of the box.
`@prefix rdfs: <https://w3id.org/rdf-lens/ontology#>.`

* `rdfl:CBD`: Provides a list of quads bounded by the cbd algorithm.
* `rdfl:PathLens`: Parses a shacl Path and returns a Lens that resolves this path.
* `rdfl:Context`: Provides a reference to the list of all data quads.
* `rdfl:TypeExtract`: Extracts according to the `rdf:type` object (including class hierarchy), by using the shape that corresponds to that type.

