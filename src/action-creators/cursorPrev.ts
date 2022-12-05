import Thunk from '../@types/Thunk'
import setCursor from '../action-creators/setCursor'
import suppressExpansion from '../action-creators/suppressExpansion'
import { HOME_TOKEN } from '../constants'
import scrollCursorIntoView from '../device/scrollCursorIntoView'
import attributeEquals from '../selectors/attributeEquals'
import findDescendant from '../selectors/findDescendant'
import { getChildrenSorted } from '../selectors/getChildren'
import isContextViewActive from '../selectors/isContextViewActive'
import prevContext from '../selectors/prevContext'
import { prevSibling } from '../selectors/prevSibling'
import rootedParentOf from '../selectors/rootedParentOf'
import appendToPath from '../util/appendToPath'
import head from '../util/head'
import parentOf from '../util/parentOf'

/** Moves the cursor to the previous sibling, ignoring descendants. */
const cursorPrev = (): Thunk => (dispatch, getState) => {
  const state = getState()
  const { cursor } = state

  if (!cursor) {
    const children = getChildrenSorted(state, HOME_TOKEN)
    if (children.length > 0) {
      dispatch(setCursor({ path: [children[0].id] }))
      scrollCursorIntoView()
    }
    return
  }

  const showContexts = isContextViewActive(state, parentOf(cursor))
  const prev = showContexts ? prevContext(state, cursor) : prevSibling(state, cursor)
  if (!prev) return

  const path = appendToPath(rootedParentOf(state, cursor), prev.id)
  const pathParent = rootedParentOf(state, path)
  const parentId = head(pathParent)
  const isCursorPinned =
    attributeEquals(state, head(path), '=pin', 'true') || findDescendant(state, parentId, ['=children', '=pin', 'true'])
  const isTable = attributeEquals(state, parentId, '=view', 'Table')

  // just long enough to keep the expansion suppressed during cursor movement in rapid succession
  if (!isCursorPinned && !isTable) {
    dispatch(suppressExpansion())
  }

  dispatch(setCursor({ path }))
  scrollCursorIntoView()
}

export default cursorPrev
