// public/js/h.js — React + htm bindings (SPEC §12). React, ReactDOM and htm are UMD globals
// loaded as classic scripts before any module runs.
// Plain one-name-per-line exports: Hatchable's deploy parser rejects destructured exports.
export const React = window.React;
export const ReactDOM = window.ReactDOM;

export const html = window.htm.bind(React.createElement);
export const useState = React.useState;
export const useEffect = React.useEffect;
export const useRef = React.useRef;
export const useMemo = React.useMemo;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const createContext = React.createContext;
export const Fragment = React.Fragment;
export const useLayoutEffect = React.useLayoutEffect;
export const useReducer = React.useReducer;
export const memo = React.memo;
export const forwardRef = React.forwardRef;
export const useId = React.useId;
export const createPortal = ReactDOM.createPortal;
