import _ from 'lodash'
import State from '../@types/State'

/** Set state.isPushing to track a sync in progress. Used by pullQueue to pause pull until push completes. Only called from the pushQueue. Called when flushPushQueue starts, not push itself. */
const isPushing = (state: State, { value }: { value: boolean }) => ({
  ...state,
  isPushing: value,
})

export default _.curryRight(isPushing)
