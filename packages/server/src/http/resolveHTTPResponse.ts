/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  AnyRouter,
  ProcedureType,
  callProcedure,
  inferRouterContext,
  inferRouterError,
} from '../core';
import { TRPCError, getTRPCErrorFromUnknown } from '../error/TRPCError';
import { getCauseFromUnknown } from '../error/utils';
import { TRPCResponse } from '../rpc';
import { transformTRPCResponse } from '../shared/transformTRPCResponse';
import { Maybe } from '../types';
import { getHTTPStatusCode } from './getHTTPStatusCode';
import { HTTPHeaders, HTTPResponse } from './internals/types';
import { HTTPBaseHandlerOptions, HTTPRequest } from './types';

const HTTP_METHOD_PROCEDURE_TYPE_MAP: Record<
  string,
  ProcedureType | undefined
> = {
  GET: 'query',
  POST: 'mutation',
};
function getRawProcedureInputOrThrow(opts: {
  req: HTTPRequest;
  preprocessed?: boolean;
}) {
  const { req } = opts;
  try {
    if (req.method === 'GET') {
      if (!req.query.has('input')) {
        return undefined;
      }
      const raw = req.query.get('input');
      return JSON.parse(raw!);
    }
    if (!opts.preprocessed && typeof req.body === 'string') {
      // A mutation with no inputs will have req.body === ''
      return req.body.length === 0 ? undefined : JSON.parse(req.body);
    }
    return req.body;
  } catch (err) {
    throw new TRPCError({
      code: 'PARSE_ERROR',
      cause: getCauseFromUnknown(err),
    });
  }
}

interface ResolveHTTPRequestOptions<
  TRouter extends AnyRouter,
  TRequest extends HTTPRequest,
> extends HTTPBaseHandlerOptions<TRouter, TRequest> {
  createContext: () => Promise<inferRouterContext<TRouter>>;
  req: TRequest;
  path: string;
  error?: Maybe<TRPCError>;
  preprocessedBody?: boolean;
}

export async function resolveHTTPResponse<
  TRouter extends AnyRouter,
  TRequest extends HTTPRequest,
>(opts: ResolveHTTPRequestOptions<TRouter, TRequest>): Promise<HTTPResponse> {
  const { router, req } = opts;
  const batchingEnabled = opts.batching?.enabled ?? true;
  if (req.method === 'HEAD') {
    // can be used for lambda warmup
    return {
      status: 204,
    };
  }
  const type =
    HTTP_METHOD_PROCEDURE_TYPE_MAP[req.method] ?? ('unknown' as const);
  let ctx: inferRouterContext<TRouter> | undefined = undefined;
  let paths: string[] | undefined = undefined;

  const isBatchCall = !!req.query.get('batch');
  type TRouterError = inferRouterError<TRouter>;
  type TRouterResponse = TRPCResponse<unknown, TRouterError>;

  function endResponse(
    untransformedJSON: TRouterResponse | TRouterResponse[],
    errors: TRPCError[],
  ): HTTPResponse {
    let status = getHTTPStatusCode(untransformedJSON);
    const headers: HTTPHeaders = {
      'Content-Type': 'application/json',
    };

    const meta =
      opts.responseMeta?.({
        ctx,
        paths,
        type,
        data: Array.isArray(untransformedJSON)
          ? untransformedJSON
          : [untransformedJSON],
        errors,
      }) ?? {};

    for (const [key, value] of Object.entries(meta.headers ?? {})) {
      headers[key] = value;
    }
    if (meta.status) {
      status = meta.status;
    }

    const transformedJSON = transformTRPCResponse(router, untransformedJSON);

    const body = JSON.stringify(transformedJSON);

    return {
      body,
      status,
      headers,
    };
  }

  try {
    if (opts.error) {
      throw opts.error;
    }
    if (isBatchCall && !batchingEnabled) {
      throw new Error(`Batching is not enabled on the server`);
    }
    /* istanbul ignore if -- @preserve */
    if (type === 'subscription') {
      throw new TRPCError({
        message: 'Subscriptions should use wsLink',
        code: 'METHOD_NOT_SUPPORTED',
      });
    }
    if (type === 'unknown') {
      throw new TRPCError({
        message: `Unexpected request method ${req.method}`,
        code: 'METHOD_NOT_SUPPORTED',
      });
    }
    const rawInput = getRawProcedureInputOrThrow({
      req,
      preprocessed: opts.preprocessedBody,
    });

    paths = isBatchCall ? opts.path.split(',') : [opts.path];
    ctx = await opts.createContext();

    const deserializeInputValue = (rawValue: unknown) => {
      return typeof rawValue !== 'undefined'
        ? router._def._config.transformer.input.deserialize(rawValue)
        : rawValue;
    };
    const getInputs = (): Record<number, unknown> => {
      if (!isBatchCall) {
        return {
          0: deserializeInputValue(rawInput),
        };
      }

      /* istanbul ignore if -- @preserve */
      if (
        rawInput == null ||
        typeof rawInput !== 'object' ||
        Array.isArray(rawInput)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: '"input" needs to be an object when doing a batch call',
        });
      }
      const input: Record<number, unknown> = {};
      for (const key in rawInput) {
        const k = key as any as number;
        const rawValue = rawInput[k];

        const value = deserializeInputValue(rawValue);

        input[k] = value;
      }
      return input;
    };
    const inputs = getInputs();

    const rawResults = await Promise.all(
      paths.map(async (path, index) => {
        const input = inputs[index];

        try {
          const output = await callProcedure({
            procedures: router._def.procedures,
            path,
            rawInput: input,
            ctx,
            type,
          });
          return {
            input,
            path,
            data: output,
          };
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);

          opts.onError?.({ error, path, input, ctx, type: type, req });
          return {
            input,
            path,
            error,
          };
        }
      }),
    );
    const errors = rawResults.flatMap((obj) => (obj.error ? [obj.error] : []));
    const resultEnvelopes = rawResults.map((obj): TRouterResponse => {
      const { path, input } = obj;

      if (obj.error) {
        return {
          error: router.getErrorShape({
            error: obj.error,
            type,
            path,
            input,
            ctx,
          }),
        };
      } else {
        return {
          result: {
            data: obj.data,
          },
        };
      }
    });

    const result = isBatchCall ? resultEnvelopes : resultEnvelopes[0]!;
    return endResponse(result, errors);
  } catch (cause) {
    // we get here if
    // - batching is called when it's not enabled
    // - `createContext()` throws
    // - post body is too large
    // - input deserialization fails
    // - `errorFormatter` return value is malformed
    const error = getTRPCErrorFromUnknown(cause);

    opts.onError?.({
      error,
      path: undefined,
      input: undefined,
      ctx,
      type: type,
      req,
    });
    return endResponse(
      {
        error: router.getErrorShape({
          error,
          type,
          path: undefined,
          input: undefined,
          ctx,
        }),
      },
      [error],
    );
  }
}
