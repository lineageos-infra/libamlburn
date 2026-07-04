/**
 * Initiate a promise, but reject if it takes too long
 * @param promise - the promise to start
 * @param reason - the error message to use in case of failure
 * @param ms - the number of milliseconds to wait before reporting failure
 */
export const timeoutPromise = <T>(promise: Promise<T>, reason: string, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
