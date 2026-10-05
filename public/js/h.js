// public/js/h.js — React + htm bindings (SPEC §12). React, ReactDOM and htm are UMD globals
// loaded as classic scripts before any module runs.
const React = window.React;
const ReactDOM = window.ReactDOM;

export const html = window.htm.bind(React.createElement);
export const {
  useState, useEffect, useRef, useMemo, useCallback, useContext, createContext, Fragment,
  useLayoutEffect, useReducer, memo, forwardRef, useId,
} = React;
export const createPortal = ReactDOM.createPortal;
export { React, ReactDOM };
