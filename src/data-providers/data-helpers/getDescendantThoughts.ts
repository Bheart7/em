import _ from 'lodash'
import Index from '../../@types/IndexType'
import State from '../../@types/State'
import Thought from '../../@types/Thought'
import ThoughtId from '../../@types/ThoughtId'
import ThoughtIndices from '../../@types/ThoughtIndices'
import ThoughtWithChildren from '../../@types/ThoughtWithChildren'
import { EM_TOKEN, EXPAND_THOUGHT_CHAR } from '../../constants'
import { getAncestorBy } from '../../selectors/getAncestorByValue'
import getThoughtById from '../../selectors/getThoughtById'
import thoughtToPath from '../../selectors/thoughtToPath'
import { createChildrenMapFromThoughts } from '../../util/createChildrenMap'
import filterObject from '../../util/filterObject'
import hashPath from '../../util/hashPath'
import hashThought from '../../util/hashThought'
import head from '../../util/head'
import isAttribute from '../../util/isAttribute'
import keyValueBy from '../../util/keyValueBy'
import never from '../../util/never'
import { getSessionId } from '../../util/sessionManager'
import { DataProvider } from '../DataProvider'

const MAX_DEPTH = 100
const MAX_THOUGHTS_QUEUED = 100

interface Options {
  maxDepth?: number
  // if true, missing ancestors are not loaded
  // must be set when deleting pending descendants
  preventLoadingAncestors?: boolean
}

/** A very simple queue. */
const queue = <T>(initialValue: T[] = []) => {
  let list: T[] = [...initialValue]

  // the total number of thoughts that have been queued
  let total = 0

  return {
    /** Adds one or more items to the queue and updates the total count. */
    add: (values: T[]) => {
      list = [...list, ...values]
      total += values.length
    },
    list: () => [...list],
    /** Gets the full contents of the queue and clears it. */
    next: () => {
      const copy = [...list]
      list = []
      return copy
    },
    /** Returns the number of items in the list. */
    size: () => list.length,
    /** Returns the total number of items ever queued. */
    total: () => total,
  }
}

/** A very simple counter. */
const counter = (initialValue = 0) => {
  let n = initialValue
  return {
    get: () => n,
    inc: (step = 1) => {
      n += step
      return n
    },
  }
}

/** Returns true if a Thought is a meta attribute but not =archive. */
const isUnarchivedAttribute = (thought: Thought) => isAttribute(thought.value) && thought.value !== '=archive'

/** Returns true if a Thought is a meta attribute or is a descendant of a meta attribute. Ignores =archive. */
const isMetaDescendant = (state: State, thought: Thought) =>
  isUnarchivedAttribute(thought) || getAncestorBy(state, thought.id, isUnarchivedAttribute)

/** Returns true if a thought is expanded. O(depth) because expanded is keyed by Path. */
const isThoughtExpanded = (state: State, thoughtId: ThoughtId) =>
  !!state.expanded[hashPath(thoughtToPath(state, thoughtId))]

/** Convert a ThoughtWithChildren to a Thought. */
const toThought = (thoughtWithChildren: ThoughtWithChildren): Thought => ({
  ..._.omit(thoughtWithChildren, 'children'),
  childrenMap: createChildrenMapFromThoughts(Object.values(thoughtWithChildren.children || {})),
})

/**
 * Returns buffered lexemeIndex and thoughtIndex for all descendants using async iterables.
 *
 * @param context
 * @param children
 * @param maxDepth    The maximum number of levels to traverse. When reached, adds pending: true to the returned Parent. Ignored for EM context. Default: 100.
 */
async function* getDescendantThoughts(
  provider: DataProvider,
  thoughtId: ThoughtId,
  getState: () => State,
  { maxDepth = MAX_DEPTH, preventLoadingAncestors }: Options = {},
): AsyncIterable<ThoughtIndices> {
  // use queue for breadth-first loading
  const thoughtIdQueue = queue([thoughtId]) // eslint-disable-line fp/no-let
  const depth = counter() // eslint-disable-line fp/no-let

  // thoughtIndex and lexemeIndex that are kept up-to-date with yielded thoughts
  const accumulatedThoughts = { ...getState().thoughts }

  // cache children fetched with getThoughtWithChildren to avoid additional db calls
  // TODO: childrenCache can be removed for better memory efficiency yielding the children of getThoughtWithChildren within the same iteration that they are fetched. This is a transitional implementation to minimize risk. Refactoring will likely affect which thoughts are pending and may affect the tests.
  let childrenCache: Index<Thought> = {}

  // eslint-disable-next-line fp/no-loops
  while (thoughtIdQueue.size() > 0) {
    // thoughts may be missing, such as __ROOT__ on first load, or deleted ids
    // filter out the missing thought ids and proceed as usual
    // const providerThoughtsRaw = await provider.getThoughtsByIds(thoughtIdQueue.get())

    // Add the cursor to the queue if the cursor is pending.
    // This ensures that if the cursor is moved while thoughts are still loading, the cursor will always be loaded at the first possible opportunity.
    // This must be done here (within getDescendantThoughts) instead of in the pull queue to ensure that the cursor is fetched even in the middle of a long pull.
    // Though it results in redundant fetches, this approach is far less complex and far fewer implications than adding pause/resume support or a shared queue.
    // TODO: Avoid redundant cursor fetches
    const cursor = getState().cursor
    const cursorThought = cursor ? (getThoughtById(getState(), head(cursor)) as Thought | null) : null
    const pendingCursorId = cursor && (!cursorThought || cursorThought?.pending) ? ([head(cursor)] as [ThoughtId]) : []

    const ids: ThoughtId[] = [...pendingCursorId, ...thoughtIdQueue.next()]

    // get thoughts from the cache or the database
    // if database, use the efficient getThoughtWithChildren and cache the thought's children for efficiency
    // see childrenCache above for more information
    const providerThoughtsRaw: (Thought | ThoughtWithChildren | undefined)[] = await Promise.all(
      // eslint-disable-next-line no-loop-func
      ids.map(async id => {
        if (childrenCache[id]) {
          return childrenCache[id]
        }
        const thoughtWithChildren = await provider.getThoughtWithChildren(id)
        if (thoughtWithChildren) {
          childrenCache = {
            ...childrenCache,
            // filter out pending children so that they are fetched normally
            // See /src/@types/ThoughtWithChildren.ts
            ...filterObject(thoughtWithChildren.children, (id, child) => !child.pending),
          }
        }
        return thoughtWithChildren
      }),
    )

    const providerThoughtsValidated = providerThoughtsRaw.filter(Boolean) as (Thought | ThoughtWithChildren)[]
    const thoughtIdsValidated = ids.filter((value, i) => providerThoughtsRaw[i])
    const pulledThoughtIndex = keyValueBy(thoughtIdsValidated, (id, i) => ({
      [id]: (providerThoughtsValidated[i] as ThoughtWithChildren).children
        ? toThought(providerThoughtsValidated[i] as ThoughtWithChildren)
        : (providerThoughtsValidated[i] as Thought),
    }))

    accumulatedThoughts.thoughtIndex = { ...accumulatedThoughts.thoughtIndex, ...pulledThoughtIndex }

    const updatedState: State = {
      ...getState(),
      thoughts: {
        ...getState().thoughts,
        ...accumulatedThoughts,
      },
    }

    const thoughts = providerThoughtsValidated
      .map(thoughtWithChildren => {
        if (thoughtWithChildren.value == null) {
          console.warn('Undefined thought value.', provider.name, thoughtWithChildren)
          return null
        }

        const isWithChildren = (thoughtWithChildren as ThoughtWithChildren).children
        const thought = isWithChildren
          ? toThought(thoughtWithChildren as ThoughtWithChildren)
          : (thoughtWithChildren as Thought)
        const childrenIds = Object.values(thought.childrenMap)
        const isEmDescendant = thoughtId === EM_TOKEN
        const hasChildren = Object.keys(thought.childrenMap || {}).length > 0
        const isMaxDepthReached = depth.get() >= maxDepth
        const isMaxThoughtsReached = thoughtIdQueue.total() + childrenIds.length > MAX_THOUGHTS_QUEUED
        const isExpanded = isThoughtExpanded(updatedState, thought.id)
        const parent = getThoughtById(updatedState, thought.parentId)

        // load ancestors of tangential contexts
        if (!parent && !preventLoadingAncestors) {
          thoughtIdQueue.add([thought.parentId])
        }

        const isVisible =
          // we need to check directly for =pin, since it is a sibling and thus not part of accumulatedThoughts yet
          // technically =pin/false is a false positive here, and will cause some thoughts not to be buffered that should, but it is rare
          // we need to determine if this thought should be buffered now, and cannot wait for the =pin child to load
          isExpanded ||
          !!isThoughtExpanded(updatedState, thought.parentId) ||
          !!parent?.childrenMap?.['=pin'] ||
          parent?.value.endsWith(EXPAND_THOUGHT_CHAR)

        // if either the max depth or the max number of thoughts are reached, mark the thought as pending and do not add enqueue children (i.e. buffering)
        // do not buffer leaves, visible thoughts, EM and its descendants, or meta attributes (excluding =archive) and their descendants
        // buffer if max thoughts are reached and the thought is not visible
        const isPending =
          (isMaxDepthReached || isMaxThoughtsReached) &&
          hasChildren &&
          !isVisible &&
          !isEmDescendant &&
          !isMetaDescendant(updatedState, thought)

        // once the buffer limit has been reached, set thoughts with children as pending
        // do not buffer descendants of EM
        // do not buffer descendants of functions (except =archive)
        if (isPending) {
          // enqueue =pin even if the thought is buffered
          // when =pin/true is loaded, then this thought will be marked as expanded and its children can be loaded
          if (thought.childrenMap?.['=pin']) {
            thoughtIdQueue.add([thought.childrenMap?.['=pin']])
          }
          return {
            ...thought,
            lastUpdated: never(),
            updatedBy: getSessionId(),
            pending: true,
          }
        } else {
          thoughtIdQueue.add(childrenIds)
          return thought
        }
      })
      .filter(Boolean) as Thought[]

    // Note: Since Parent.children is now array of ids instead of Child we need to inclued the non pending leaves as well.
    const thoughtIndex = keyValueBy(thoughtIdsValidated, (id, i) => ({ [id]: thoughts[i] }))

    const thoughtHashes = thoughtIdsValidated.map(id => {
      const thought = getThoughtById(updatedState, id)
      if (!thought) {
        throw new Error(`Thought not found for id${id}`)
      }
      return hashThought(thought.value)
    })

    const lexemes = await provider.getLexemesByIds(thoughtHashes)

    const lexemeIndex = keyValueBy(thoughtHashes, (id, i) => (lexemes[i] ? { [id]: lexemes[i]! } : null))

    accumulatedThoughts.thoughtIndex = { ...accumulatedThoughts.thoughtIndex, ...thoughtIndex }
    accumulatedThoughts.lexemeIndex = { ...accumulatedThoughts.lexemeIndex, ...lexemeIndex }

    yield {
      thoughtIndex,
      lexemeIndex,
    }

    depth.inc()
  }
}

export default getDescendantThoughts
