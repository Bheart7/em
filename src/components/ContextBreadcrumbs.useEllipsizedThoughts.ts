import _ from 'lodash'
import { useSelector } from 'react-redux'
import SimplePath from '../@types/SimplePath'
import State from '../@types/State'
import ThoughtId from '../@types/ThoughtId'
import getThoughtById from '../selectors/getThoughtById'
import editingValueStore from '../stores/editingValue'
import head from '../util/head'
import strip from '../util/strip'

type OverflowChild = {
  id: ThoughtId
  value: string
  label?: string
  isOverflow?: boolean
}

type OverflowPath = OverflowChild[]

/** Ellipsizes thoughts in a path by thoughtsLimit and charLimit. Re-renders when simplePath values change, including live edits. Complexity: O(n), but does not work if thoughtsLimit or charLimit are undefined. */
const useEllipsizedThoughts = (
  simplePath: SimplePath,
  { disabled, thoughtsLimit, charLimit }: { disabled?: boolean; thoughtsLimit?: number; charLimit?: number },
): OverflowPath => {
  // calculate if overflow occurs during ellipsized view
  // 0 if thoughtsLimit is not defined
  const thoughtsOverflow =
    thoughtsLimit && simplePath.length > thoughtsLimit ? simplePath.length - thoughtsLimit + 1 : 0

  const editingValue = editingValueStore.useState()

  // convert the SimplePath to a list of thought values
  // if editing, use the live editing value
  const thoughtValuesLive = useSelector(
    (state: State) =>
      simplePath.map(id =>
        editingValue && state.cursor && id === head(state.cursor) ? editingValue : getThoughtById(state, id)?.value,
      ),
    _.isEqual,
  )

  // if charLimit is exceeded then replace the remaining characters with an ellipsis
  const charLimitedThoughts: OverflowPath = simplePath.map((id, i) => {
    const value = thoughtValuesLive[i]
    return {
      value,
      id,
      // add ellipsized label
      ...(!disabled
        ? {
            label: strip(
              // subtract 2 so that additional '...' is still within the char limit
              value.length > charLimit! - 2 ? value.slice(0, charLimit! - 2) + '...' : value,
            ),
          }
        : {}),
    }
  })

  // after character limit is applied we need to remove the overflow thoughts if any and add isOverflow flag to render ellipsis at that position
  const ellipsizedThoughts: OverflowPath =
    thoughtsOverflow && !disabled
      ? charLimitedThoughts
          .slice(0, charLimitedThoughts.length - 1 - thoughtsOverflow)
          .concat({ isOverflow: true } as OverflowChild, charLimitedThoughts.slice(charLimitedThoughts.length - 1))
      : charLimitedThoughts

  return ellipsizedThoughts
}

export default useEllipsizedThoughts
