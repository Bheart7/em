import _ from 'lodash'
import lifecycle from 'page-lifecycle'
import { Store } from 'redux'
import LifecycleState from '../@types/LifecycleState'
import Path from '../@types/Path'
import State from '../@types/State'
import alert from '../action-creators/alert'
import distractionFreeTyping from '../action-creators/distractionFreeTyping'
import error from '../action-creators/error'
import setCursor from '../action-creators/setCursor'
import { AlertType } from '../constants'
import scrollCursorIntoView from '../device/scrollCursorIntoView'
import * as selection from '../device/selection'
import decodeThoughtsUrl from '../selectors/decodeThoughtsUrl'
import pathExists from '../selectors/pathExists'
import { inputHandlers } from '../shortcuts'
import store from '../stores/app'
import pushStore from '../stores/push'
import { updateHeight, updateScrollTop } from '../stores/viewport'
import isRoot from '../util/isRoot'
import pathToContext from '../util/pathToContext'
import equalPath from './equalPath'
import { keepalive } from './sessionManager'
import { getVisibilityChangeEventName, isTabHidden } from './visibilityApiHelpers'

declare global {
  interface Window {
    __inputHandlers: ReturnType<typeof inputHandlers>
  }
}

/** An autoscroll function that will continue scrolling smoothly in a given direction until autoscroll.stop is called. Takes a number of pixels to scroll each iteration. */
const autoscroll = (() => {
  /** Cubic easing function. */
  const ease = (n: number) => Math.pow(n, 3)

  // if true, the window will continue to be scrolled at the current rate without user interaction
  let autoscrolling = false

  // scroll speed (-1 to 1)
  let rate = 1

  // cache the autoscroll container on start for performance
  // if the Sidebar is open on touch start, this is set to the .sidebar element
  let scrollContainer: Window | HTMLElement = window

  /** Scroll vertically in the direction given by rate until stop is called. Defaults to scrolling the window, or you can pass an element to scroll. */
  const scroll = () => {
    const el = scrollContainer || window
    // if scrollContainer is undefined or window, use the document scrollTop
    const scrollTop = (scrollContainer as HTMLElement).scrollTop ?? document.documentElement.scrollTop
    const scrollTopNew = Math.max(0, scrollTop + rate)

    // if we have hit the end, stop autoscrolling
    // i.e. if the next increment would not change scrollTop
    if (scrollTopNew === scrollTop) {
      autoscrolling = false
      return
    }

    el.scrollTo(0, scrollTopNew)
    window.requestAnimationFrame(() => {
      if (autoscrolling) {
        scroll()
      }
    })
  }

  /** Starts the autoscroll or, if already scrolling, updates the scroll rate (-1 to 1). */
  const startOrUpdate = (rateNew?: number) => {
    // update the scroll rate
    rate = ease(rateNew ?? 1)

    // if we are already autoscrolling, do nothing
    if (autoscrolling) return

    // otherwise kick off the autoscroll
    autoscrolling = true
    scrollContainer = (document.querySelector('.sidebar') as HTMLElement | null) || window
    scroll()
  }

  /** Stops scrolling. */
  startOrUpdate.stop = () => {
    autoscrolling = false
  }

  return startOrUpdate
})()

/** Add window event handlers. */
const initEvents = (store: Store<State, any>) => {
  let lastState: number // eslint-disable-line fp/no-let
  let lastPath: Path | null // eslint-disable-line fp/no-let

  /** Popstate event listener; setCursor on browser history forward/backward. */
  const onPopstate = (e: PopStateEvent) => {
    const state = store.getState()

    const { path, contextViews } = decodeThoughtsUrl(state)

    if (!lastPath) {
      lastPath = state.cursor
    }

    if (!path || !pathExists(state, pathToContext(state, path)) || equalPath(lastPath, path)) {
      window.history[!lastState || lastState > e.state ? 'back' : 'forward']()
    }

    lastPath = path && pathExists(state, pathToContext(state, path)) ? path : lastPath
    lastState = e.state

    const toRoot = !path || isRoot(path)

    // clear the selection if root
    if (toRoot) {
      selection.clear()
    }

    // set the cursor
    const cursor = toRoot ? null : path

    store.dispatch([
      // check if path is the root, since decodeThoughtsUrl returns a rooted path rather than null
      setCursor({ path: cursor, replaceContextViews: contextViews }),

      // scroll cursor into view
      scrollCursorIntoView(),
    ])
  }

  /** MouseMove event listener. */
  const onMouseMove = _.debounce(() => store.dispatch(distractionFreeTyping(false)), 100, { leading: true })

  /** Handles auto scroll on drag near the edge of the screen on mobile. */
  // TOOD: Autoscroll for desktop. mousemove is not propagated when drag-and-drop is activated. We may need to tap into canDrop.
  const onTouchMove = (e: TouchEvent) => {
    const state = store.getState()

    // do not auto scroll when hovering over QuickDrop component
    if (
      !state.dragInProgress ||
      state.alert?.alertType === AlertType.DeleteDropHint ||
      state.alert?.alertType === AlertType.CopyOneDropHint
    )
      return

    const y = e.touches[0].clientY

    // start scrolling up when within 100px of the top edge of the screen
    if (y < 120) {
      const rate = 1 + (120 - y) / 60
      autoscroll(-rate)
    }
    // start scrolling down when within 100px of the bottom edge of the screen
    else if (y > window.innerHeight - 100) {
      const rate = 1 + (y - window.innerHeight + 100) / 50
      autoscroll(rate)
    }
    // stop scrolling when not near the edge of the screen
    else {
      autoscroll.stop()
    }
  }

  /** Stops the autoscroll when dragging stops. */
  const onTouchEnd = (e: TouchEvent) => {
    autoscroll.stop()
  }

  /** Url change and reload listener. */
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    const shouldConfirmReload = pushStore.getState().isPushing

    if (shouldConfirmReload) {
      // Note: Showing confirmation dialog can vary between browsers.
      // See: https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event
      e.preventDefault()
      e.returnValue = ''
      return ''
    }
  }

  /** Handle a page lifecycle state change, i.e. switching apps. */
  const onStateChange = ({ oldState, newState }: { oldState: LifecycleState; newState: LifecycleState }) => {
    if (newState === 'hidden' || oldState === 'hidden') {
      // dismiss the gesture alert if active
      const alertType = store.getState().alert?.alertType
      if (alertType === AlertType.GestureHint || alertType === AlertType.GestureHintExtended) {
        store.dispatch(alert(null))
      }
      // we could also persist unsaved data here
    }
  }

  // store input handlers so they can be removed on cleanup
  const { keyDown, keyUp } = (window.__inputHandlers = inputHandlers(store))

  /** Update local storage sessions used for managing subscriptions. */
  const onTabVisibilityChanged = () => {
    if (!isTabHidden()) {
      keepalive()
    }
  }

  // prevent browser from restoring the scroll position so that we can do it manually
  window.history.scrollRestoration = 'manual'

  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
  window.addEventListener('popstate', onPopstate)
  window.addEventListener('mousemove', onMouseMove)
  // Note: touchstart may not be propagated after dragHold
  window.addEventListener('touchmove', onTouchMove)
  window.addEventListener('touchend', onTouchEnd)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('resize', updateHeight)
  window.addEventListener('scroll', updateScrollTop)
  window.addEventListener(getVisibilityChangeEventName() || 'focus', onTabVisibilityChanged)

  // clean up on app switch in PWA
  // https://github.com/cybersemics/em/issues/1030
  lifecycle.addEventListener('statechange', onStateChange)

  /** Remove window event handlers. */
  const cleanup = ({ keyDown, keyUp } = window.__inputHandlers || {}) => {
    window.removeEventListener('keydown', keyDown)
    window.removeEventListener('keyup', keyUp)
    window.removeEventListener('popstate', onPopstate)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('touchmove', onTouchMove)
    window.removeEventListener('touchend', onTouchEnd)
    window.removeEventListener('beforeunload', onBeforeUnload)
    window.removeEventListener('resize', updateHeight)
    window.removeEventListener('scroll', updateScrollTop)
    window.removeEventListener(getVisibilityChangeEventName() || 'focus', onTabVisibilityChanged)
    lifecycle.removeEventListener('statechange', onStateChange)
  }

  // return input handlers as another way to remove them on cleanup
  return { keyDown, keyUp, cleanup }
}

/** Error event listener. This does not catch React errors. See the ErrorFallback component that is used in the error boundary of the App component. */
// const onError = (e: { message: string; error?: Error }) => {
const onError = (e: any) => {
  console.error({ message: e.message, code: e.code, 'error.code': (error as any).code, errors: e.errors })
  if (e.error && 'stack' in e.error) {
    console.error(e.error.stack)
  }
  store.dispatch(error({ value: e.message }))
}

// error handler must be added immediately to catch auth errors
if (typeof window !== 'undefined') {
  window.addEventListener('error', onError)
}

export default initEvents
