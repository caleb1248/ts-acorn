// The parts of the host environment the library uses. Declared here
// rather than pulling in DOM or Node typings.
declare var console: {warn?: (message: string) => void} | undefined
