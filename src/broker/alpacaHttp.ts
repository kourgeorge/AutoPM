/**
 * The Alpaca HTTP transport — both base URLs, one place.
 *
 * Alpaca splits its API across two hosts (trading and market data) that take the SAME two
 * credential headers. That header pair was previously constructed in three separate files,
 * which is three places to get a credential wrong and three places to miss a change to how
 * the key is read. Everything that talks to Alpaca over REST imports from here.
 *
 * Deliberately just the configured axios instances: no retry, no interceptor, no error
 * translation. Each caller wants something different from a failure — the broker raises a
 * `BrokerRejection`, `priceSource` preserves the error as provenance in a `Maybe`, and the
 * data tools hand the message to the model — so a shared opinion here would be wrong for
 * two of the three.
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../core/config';

function makeClient(baseURL: string): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      'APCA-API-KEY-ID': config.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    },
  });
}

/** Orders, positions, account, activities, clock. */
export const alpacaTrading = makeClient(config.alpaca.baseUrl);

/** Bars, snapshots, quotes, screeners, news. */
export const alpacaData = makeClient(config.alpaca.dataUrl);
