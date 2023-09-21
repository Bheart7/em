import emojiStrip from 'emoji-strip'
import _ from 'lodash'
import * as pluralize from 'pluralize'
import { REGEXP_TAGS } from '../constants'
import isAttribute from './isAttribute'

/**
 * Removes whitespace from a value (removes non-word character).
 * Preserves metaprogramming attribute character `=`.
 */
const removeWhitespaceAndPunctuation = (s: string) => {
  const modifiedString = isAttribute(s) ? s.slice(1) : s
  const replaced = modifiedString.replace(
    modifiedString.length > 0 && modifiedString.replace(/\W/g, '').length > 0 ? /\W/g : /s/g,
    '',
  )
  return s !== modifiedString ? '=' + replaced : replaced
}

/** Strips emoji from text. Preserves emoji on its own. */
const stripEmojiFromText = (s: string) => {
  const stripped = emojiStrip(s)
  return stripped.length > 0 ? stripped : s
}

/** Strips all html tags. */
const stripTags = (s: string) => s.replace(REGEXP_TAGS, '')

/**
 * Making character 's' will just become an empty value ''.
 * Skip it else it will cause "s" character to have same no of context as empty thoughts in the entire tree. */
const singularize = (s: string) => (s !== 's' ? pluralize.singular(s) : s)

/** Converts a string to lowecase. */
const lower = (s: string) => s.toLowerCase()

/**
 * Converts a thought value into a canonical form that is stored in Lexeme.lemma.
 * Not idempotent (singularize may return a different string after whitespace is removed).
 */
const normalizeThought = _.memoize(
  _.flow([
    // stripTags must be placed before stripEmojiWithText because stripEmojiWithText partially removes angle brackets
    stripTags,
    lower,
    removeWhitespaceAndPunctuation,
    stripEmojiFromText,
    singularize,
  ]) as (s: string) => string,
)

export default normalizeThought
