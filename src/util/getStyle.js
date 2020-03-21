import { store } from '../store.js'

import {
  getThoughts,
  pathToContext,
} from '../util.js'

/** Parses the =style attribute of a given context into an object that can be passed to React styles */
export const getStyle = (pathOrContext, { state = store.getState() } = {}) => {

  const context = pathToContext(pathOrContext)
  const styleContext = context.concat('=style')
  const children = getThoughts(styleContext, state.thoughtIndex, state.contextIndex)

  return children.reduce((accum, { value } = {}) => {
    const styleValueThought = getThoughts(styleContext.concat(value))[0]
    return {
      ...accum,
      ...(styleValueThought
        ? {
          [value]: styleValueThought.value
        }
        : null
      )
    }
  }, {})
}
