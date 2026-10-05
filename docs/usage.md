---
title: Usage examples
category: Main
---

# Usage examples

## Load

### Basic usage

Read files explicitly as UTF-8 and pass the filename to `load()` so parse
errors identify the input source:

```javascript
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

const filename = 'config.yml'

try {
  const source = readFileSync(filename, 'utf8')
  const config = load(source, { filename })

  console.log(`Starting ${config.service.name} on port ${config.service.port}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
```

For a stream containing several YAML documents, use `loadAll()`:

```javascript
import { loadAll } from 'js-yaml'

try {
  const documents = loadAll(`
---
name: api
port: 8080
---
name: worker
concurrency: 4
`)

  console.log(documents)
} catch (e) {
  console.error(e)
}
```

Unlike `load()`, `loadAll()` accepts empty and multi-document streams. It
returns an array; an empty stream produces an empty array.

### Schema customization

The most frequent cases are:

- enabling merge keys;
- replacing the default object maps with native `Map` instances.

Here is how to do that:

```javascript
import { CORE_SCHEMA, mergeTag, realMapTag } from 'js-yaml'

const schema = CORE_SCHEMA.withTags(mergeTag, realMapTag)
```

### Alternate map tag

For the most robust object-based mappings, use objects without a prototype and
accept only string keys:

```javascript
import { CORE_SCHEMA, load, mapTag } from 'js-yaml'

const schema = CORE_SCHEMA.withTags({
  ...mapTag,
  create: () => Object.create(null),
  addPair: (container, key, value) => {
    if (typeof key !== 'string') return 'object-based map supports only string keys'
    container[key] = value
    return ''
  },
  has: (container, key) => typeof key === 'string' && key in container,
  get: (container, key) => {
    if (typeof key !== 'string' || !(key in container)) return null
    return container[key]
  }
})

try {
  const config = load('{ enabled: true, level: 2 }', { schema })
} catch (e) {
  console.error(e)
}
```

This is not the default because objects without a prototype break many common
usage examples and equality checks. Still, consider using `realMapTag` instead.

### JSON-compatible load

`loadJson()` parses a single document with the built-in JSON schema only and
guarantees a result that `JSON.stringify` accepts. Non-string mapping keys are
rejected before the mapping is built (the error mark points at the key and
names its resolved tag, e.g. `!!int`), reference cycles are rejected, shared
acyclic references are expanded into independent copies, and non-finite
numbers (`.inf`, `-.inf`, `.nan`) are rejected. Custom tags are never
constructed, and any violation throws without returning a partial result.

```javascript
import { loadJson } from 'js-yaml'

// 1) String keys (including the text "1") pass; numbers do not:
loadJson('"1": ok')   // { '1': 'ok' }
loadJson('1: ok')     // throws: mapping keys must be strings ... got !!int key (1:1)

// 2) A shared, acyclic anchor expands into independent copies:
const shared = loadJson('a: &x [1, 2]\nb: *x\n')
shared.a === shared.b  // false — each alias is its own copy

// 3) Self references and non-finite floats are refused:
loadJson('a: &a [1, *a]')  // throws: recursive alias "a" is not representable in JSON
loadJson('a: !!float .inf') // throws: non-finite value of tag !!float ...
```

Local Node one-liner (Node strips TypeScript types when importing the
sources directly, so no build step is needed):

```shell
node --input-type=module -e "import { loadJson } from './src/load.ts'; console.log(JSON.stringify(loadJson('a: &x [1, 2]\nb: *x\n')))"
```

## Dump

### Basic usage

`dump()` returns a YAML string with a trailing newline:

```javascript
import { dump } from 'js-yaml'

const config = {
  service: { name: 'api', ports: [8080, 8081] },
  logging: { level: 'info' }
}

const output = dump(config, { lineWidth: 100 })

console.log(output)
```

Unsupported values, such as functions, cause an exception by default. Use
`skipInvalid: true` only when silently dropping those values is intentional.

### Formatting scalar values

Use `DUMP_SCHEMA` as the base so its compatibility and quoting rules remain
active.

```javascript
import { DUMP_SCHEMA, boolYaml11Tag, dump, nullYaml11Tag } from 'js-yaml'

// Instead of defining a new tag, we override a single method of clone
// in one line. That's compact and simple.
const schema = DUMP_SCHEMA.withTags(
  { ...boolYaml11Tag, represent: value => value ? 'TRUE' : 'FALSE' },
  { ...nullYaml11Tag, represent: () => '' }
)

const output = dump({
  enabled: true,
  archived: false,
  parent: null
}, { schema })

console.log(output)
```

Output:

```yaml
enabled: TRUE
archived: FALSE
parent:
```

## CLI

The CLI is intentionally minimal, with no plans to extend its feature set.

```shell
npx js-yaml -h
```
