
import { equalsIgnoreCase, logger } from '.';
import { BigNumber } from 'bignumber.js'
import dayjs from './dayFormat'
import dayjs2 from './dayWithRelativeFormat'
import axios from 'axios'
import { makerListHistory, makerList, makerConfigs, IMarket } from '../configs';
import { utils } from 'ethers'
import * as Keyv from 'keyv';
const keyv = new Keyv();
async function getAllMakerList() {
  return makerList.concat(makerListHistory)
}
async function getMakerList() {
  return makerList
}

// ETH:18  USDC:6  USDT:6
const token2Decimals = {
  'ETH': 18,
  'USDC': 6,
  'USDT': 6,
  'DAI': 18
}


/**
 *
 * @param currency
 * @returns
 */
export async function cacheExchangeRates(currency = 'USD'): Promise<any> {
  // cache
  const exchangeRates = await getRates(currency)
  if (exchangeRates) {
    let metisExchangeRates = await getRates('metis')
    if (metisExchangeRates && metisExchangeRates["USD"]) {
      let usdToMetis = 1 / Number(metisExchangeRates["USD"])
      exchangeRates["METIS"] = String(usdToMetis)
    }
    return exchangeRates
  } else {
    return undefined
  }
}
export async function getRates(currency) {
    const cacheData = await keyv.get(`rates:${currency}`);
  if (cacheData) {
    return cacheData;
  }
  const resp = await axios.get(
    `https://api.coinbase.com/v2/exchange-rates?currency=${currency}&timestamp=${Date.now()}`,
  )
  const data = resp.data?.data
  // check
  if (!data || !equalsIgnoreCase(data.currency, currency) || !data.rates) {
    return undefined
  }
  await keyv.set(`rates:${currency}`, data.rates, 1000 * 60 * 5); // true
  return data.rates
}

// let exchangeRates: { [key: string]: string } | undefined

/**
 * @param sourceCurrency
 * @returns
 */
export async function getExchangeToUsdRate(
  sourceCurrency = 'ETH'
): Promise<BigNumber> {
  // toUpperCase
  sourceCurrency = sourceCurrency.toUpperCase()

  const currency = 'USD'

  let rate = -1
  try {
    const exchangeRates = await cacheExchangeRates(currency)
    if (exchangeRates?.[sourceCurrency]) {
      rate = Number(exchangeRates[sourceCurrency])
    }
  } catch (error) {
    // errorLogger.error(error)
    logger.error(error)
  }

  return new BigNumber(rate)
}

/**
 * @param value
 * @param sourceCurrency
 * @returns
 */
export async function exchangeToUsd(
  value: string | number | BigNumber,
  sourceCurrency: string
): Promise<BigNumber> {
  if (!(value instanceof BigNumber)) {
    value = new BigNumber(value)
  }

  const rate = await getExchangeToUsdRate(sourceCurrency)
  if (rate.comparedTo(0) !== 1) {
    return new BigNumber(0)
  }

  return value.dividedBy(rate)
}

const GAS_PRICE_PAID_RATE = { 2: 0.8 } // arbitrum Transaction Fee = gasUsed * gasPrice * 0.8 (general)
export async function statisticsProfit(
  makerNode
): Promise<BigNumber> {
  if (makerNode.tokenName === 'USDC' || makerNode.tokenName === 'USDT') {
    return statisticsProfitOld(makerNode)
  }
  let fromToPrecision = token2Decimals[makerNode.tokenName] || 18
  let gasPrecision = token2Decimals[makerNode.tokenName] || 18 // gas default is eth, zksync is token

  if (makerNode.tokenName && Number(makerNode.toAmount) > 0) {
    const fromMinusToUsd = await exchangeToUsd(
      new BigNumber(makerNode.fromAmount)
        .minus(makerNode.toAmount)
        .dividedBy(10 ** fromToPrecision),
      makerNode.tokenName
    )
    let gasPricePaidRate = GAS_PRICE_PAID_RATE[makerNode.toChain] || 1
    if (makerNode.gasCurrency) {
      const gasAmountUsd = await exchangeToUsd(
        new BigNumber(makerNode.gasAmount)
          .multipliedBy(gasPricePaidRate)
          .dividedBy(10 ** gasPrecision),
        makerNode.gasCurrency || ''
      )
      return fromMinusToUsd.minus(gasAmountUsd || 0)
    }
    return fromMinusToUsd;
  } else {
    return new BigNumber(0)
  }
}

// old logic use makerList
export async function statisticsProfitOld(
  makerNode
): Promise<BigNumber> {
  let fromToCurrency = ''
  let fromToPrecision = 0
  let gasPrecision = 18 // gas default is eth, zksync is token

  const makerList = await getMakerList()
  for (const item of makerList) {
    if (!equalsIgnoreCase(item.makerAddress, makerNode.makerAddress)) {
      continue
    }

    if (
      equalsIgnoreCase(item.t1Address, makerNode.txToken) ||
      equalsIgnoreCase(item.t2Address, makerNode.txToken)
    ) {
      fromToCurrency = item.tName
      fromToPrecision = item.precision
    }

    if (equalsIgnoreCase(item.tName, makerNode.gasCurrency)) {
      gasPrecision = item.precision
    }
  }

  if (fromToCurrency && Number(makerNode.toAmount) > 0) {
    let fromMinusToUsd = await exchangeToUsd(
      new BigNumber(makerNode.fromAmount)
        .minus(makerNode.toAmount)
        .dividedBy(10 ** fromToPrecision),
      fromToCurrency
    )

    let gasPricePaidRate = 1
    if (GAS_PRICE_PAID_RATE[makerNode.toChain]) {
      gasPricePaidRate = GAS_PRICE_PAID_RATE[makerNode.toChain]
    }

    if (makerNode.gasCurrency) {
      const gasAmountUsd = await exchangeToUsd(
        new BigNumber(makerNode.gasAmount)
          .multipliedBy(gasPricePaidRate)
          .dividedBy(10 ** gasPrecision),
        makerNode.gasCurrency
      )
      return fromMinusToUsd.minus(gasAmountUsd || 0)
    }

    return fromMinusToUsd;
  } else {
    return new BigNumber(0)
  }
}

export async function transforeUnmatchedTradding(list = []) {
  for (const item of list) {
    item['chainName'] = await getChainName(item.chainId)

    const decimals = token2Decimals[item.tokenName]

    item['amountFormat'] = 0
    if (decimals > -1) {
      item['amountFormat'] = new BigNumber(item.value).dividedBy(
        10 ** decimals
      )
    } else {
      logger.log(`[shared/utils/maker-node.ts transforeData] maker-node.ts should Synchronize！Error decimals!`)
    }

    // time ago
    item['txTimeAgo'] = '-'
    if (item.timestamp.getTime() > 0) {
      item['txTimeAgo'] = dayjs2().to(dayjs(new Date(item.timestamp).getTime()))
    }
  }
}
/**
 * @deprecated
 * @param chainId 
 * @returns 
 */
async function getChainName(chainId: string) {
  // Temporarily, the public chain name can be obtained from chaincore
  switch (String(chainId)) {
    case "16":
      return 'Nova';
    // oether
  }
  const makerList = await getAllMakerList();
  const row1 = makerList.find(row => String(row.c1ID) == String(chainId));
  if (row1) {
    return row1.c1Name;
  }
  const row2 = makerList.find(row => String(row.c2ID) == String(chainId));
  if (row2) {
    return row2.c2Name;
  }
  return '';
}
export async function transforeData(list = []) {
  // fill data
  for (const item of list) {
    // format tokenName and amounts
    const decimals = token2Decimals[item.tokenName]
    item['fromChainName'] = await getChainName(item.fromChain)
    item['toChainName'] = await getChainName(item.toChain)
    item.decimals = decimals
    item.toTx = item.toTx || '0x'
    if (decimals > -1) {
      item.fromAmountFormat = `${new BigNumber(item.fromValue).dividedBy(
        10 ** decimals
      )}`
      item.fromValueFormat = (+item.fromAmountFormat).toFixed(6)
      item.fromAmount = item.fromValue
      item.toAmountFormat = `${new BigNumber(item.toAmount).dividedBy(
        10 ** decimals
      )}`
    } else {
      logger.log(`[shared/utils/maker-node.ts transforeData] maker-node.ts should Synchronize！Error decimals!`)
      // tmp for show
      item.fromValueFormat = new BigNumber(+item.toAmount).dividedBy(
        10 ** 18
      ).toFixed(6)
    }

    // old logic: when not toTx, dashboard ToAmount shows: 0 (NeedTo: 0.009752000000000003)
    if (!item.toTx) {
      item.toAmount = "0"
      item.toAmountFormat = "0"
    }

    // Trade duration
    item['tradeDuration'] = 0

    // Time duration、time ago
    // const tmp = item.fromTimeStamp
    item.fromTimeStamp = item.fromTimeStamp && dayjs(item.fromTimeStamp).format('YYYY-MM-DD HH:mm:ss')
    item.toTimeStamp = item.toTimeStamp && dayjs(item.toTimeStamp).format('YYYY-MM-DD HH:mm:ss')
    const dayjsFrom: any = dayjs(item.fromTimeStamp)
    item['fromTimeStampAgo'] = dayjs2().to(dayjsFrom)
    item['toTimeStampAgo'] = '-'
    if (item.toTimeStamp && item.toTimeStamp != '0') {
      const dayjsTo = dayjs(item.toTimeStamp)
      item['toTimeStampAgo'] = dayjs2().to(dayjsTo)

      item['tradeDuration'] = dayjsTo.unix() - dayjsFrom.unix()
    }


    let market: IMarket;
    try {
      item.toSymbol = (JSON.parse(item.extra)).toSymbol;
      delete item.extra;
      market = makerConfigs.find(cfg =>
          cfg.fromChain.id == item['fromChain'] &&
          cfg.fromChain.symbol == item['tokenName'] &&
          cfg.toChain.id == item['toChain'] &&
          cfg.toChain.symbol == item.toSymbol);
    } catch (e) {
      console.log(e);
    }

    if (market) {
      item.needTo = {
        chainId: market.toChain.id,
        decimals: market.toChain.decimals,
        tokenAddress: market.toChain.tokenAddress,
        amount: item.toAmount,
        amountFormat: item['toAmountFormat'],
      };

      item.needBack = {
        chainId: market.fromChain.id,
        decimals: market.fromChain.decimals,
        tokenAddress: market.fromChain.tokenAddress,
        amount: item.fromValue,
      };
    }

    // Parse to dydx txExt
    if (item.fromExt && (item.toChain == '11' || item.toChain == '511')) {
      const data = item.fromExt.value
      const starkKey = utils.hexDataSlice(data, 0, 32)
      const positionId = parseInt(utils.hexDataSlice(data, 32), 16)
      item.fromExt['dydxInfo'] = { starkKey, positionId: String(positionId) }
    }
    // Profit statistics
    // (fromAmount - toAmount) / token's rate - gasAmount/gasCurrency's rate
    item['profitUSD'] = (await statisticsProfit(item)).toFixed(3)

    // old logic: when not toTx, dashboard Profit shows: 0.000 USD
    if (item.profitUSD === 'NaN' || !item.toTx) {
      item.profitUSD = "0.000"
    }
  }
  return list
}
