class Position {
  constructor(initialSolBalance, initialUsdcBalance, initialPrice) {
    this.solBalance = initialSolBalance;
    this.usdcBalance = initialUsdcBalance;
    this.initialValue = this.solBalance * initialPrice + this.usdcBalance;
    this.initialSolBalance = initialSolBalance;
    this.initialUsdcBalance = initialUsdcBalance;
    this.initialPrice = initialPrice;
    this.trades = [];
    this.isInitialized = true;

    // Track traded amounts separately
    this.tradedSolBalance = 0;
    this.tradedUsdcBalance = 0;

    // Enhanced statistics
    this.startTime = Date.now();
    this.totalCycles = 0;
    this.extremeFearBuys = 0;
    this.fearBuys = 0;
    this.greedSells = 0;
    this.extremeGreedSells = 0;
    this.totalVolumeSol = 0;
    this.totalVolumeUsdc = 0;
  }

  updateBalances(newSolBalance, newUsdcBalance) {
    this.solBalance = newSolBalance;
    this.usdcBalance = newUsdcBalance;
  }

  logTrade(sentiment, price, solChange, usdcChange) {
    const tradeType = solChange > 0 ? 'buy' : 'sell';

    this.trades.push({
      type: tradeType,
      solAmount: Math.abs(solChange),
      usdcAmount: Math.abs(usdcChange),
      price,
      sentiment,
      timestamp: new Date()
    });

    // Update traded balances
    this.tradedSolBalance += solChange;
    this.tradedUsdcBalance -= usdcChange;

    if (tradeType === 'buy') {
      if (sentiment === 'EXTREME_FEAR') {
        this.extremeFearBuys += Math.abs(solChange);
      } else if (sentiment === 'FEAR') {
        this.fearBuys += Math.abs(solChange);
      }
    } else if (tradeType === 'sell') {
      if (sentiment === 'GREED') {
        this.greedSells += Math.abs(solChange);
      } else if (sentiment === 'EXTREME_GREED') {
        this.extremeGreedSells += Math.abs(solChange);
      }
    }

    this.totalVolumeSol += Math.abs(solChange);
    this.totalVolumeUsdc += Math.abs(usdcChange);
  }

  getAverageEntryPrice() {
    const buyTrades = this.trades.filter(trade => trade.type === 'buy');
    const totalSolBought = buyTrades.reduce((sum, trade) => sum + trade.solAmount, 0);
    const totalUsdcSpent = buyTrades.reduce((sum, trade) => sum + trade.usdcAmount, 0);
    return totalSolBought > 0 ? totalUsdcSpent / totalSolBought : 0;
  }

  getAverageSellPrice() {
    const sellTrades = this.trades.filter(trade => trade.type === 'sell');
    const totalSolSold = sellTrades.reduce((sum, trade) => sum + trade.solAmount, 0);
    const totalUsdcReceived = sellTrades.reduce((sum, trade) => sum + trade.usdcAmount, 0);
    return totalSolSold > 0 ? totalUsdcReceived / totalSolSold : 0;
  }

  getRealizedPnL() {
    return this.trades.reduce((pnl, trade) => {
      if (trade.type === 'sell') {
        const avgEntryPrice = this.getAverageEntryPrice();
        return pnl + (trade.usdcAmount - (avgEntryPrice * trade.solAmount));
      }
      return pnl;
    }, 0);
  }

  getUnrealizedPnL(currentPrice) {
    const avgEntryPrice = this.getAverageEntryPrice();
    return (currentPrice - avgEntryPrice) * this.tradedSolBalance;
  }

  getTotalPnL(currentPrice) {
    return this.getRealizedPnL() + this.getUnrealizedPnL(currentPrice);
  }

  getCurrentValue(currentPrice) {
    return this.solBalance * currentPrice + this.usdcBalance;
  }

  getTradedValue(currentPrice) {
    return this.tradedSolBalance * currentPrice + this.tradedUsdcBalance;
  }

  getPortfolioPercentageChange(currentPrice) {
    const currentValue = this.getCurrentValue(currentPrice);
    return ((currentValue - this.initialValue) / this.initialValue) * 100;
  }

  getSolPricePercentageChange(currentPrice) {
    return ((currentPrice - this.initialPrice) / this.initialPrice) * 100;
  }

  getEnhancedStatistics(currentPrice) {
    const currentPortfolioValue = this.getCurrentValue(currentPrice);
    const portfolioChange = currentPortfolioValue - this.initialValue;
    const totalRuntime = (Date.now() - this.startTime) / 1000 / 60 / 60; // in hours
    const totalVolumeUsd = this.totalVolumeUsdc + (this.totalVolumeSol * currentPrice);

    return {
      totalRuntime: totalRuntime.toFixed(2),
      totalCycles: this.totalCycles,
      portfolioValue: {
        initial: this.initialValue.toFixed(2),
        current: currentPortfolioValue.toFixed(2),
        change: portfolioChange.toFixed(2),
        percentageChange: this.getPortfolioPercentageChange(currentPrice).toFixed(2)
      },
      solPrice: {
        initial: this.initialPrice.toFixed(2),
        current: currentPrice.toFixed(2),
        percentageChange: this.getSolPricePercentageChange(currentPrice).toFixed(2)
      },
      pnl: {
        realized: this.getRealizedPnL().toFixed(2),
        unrealized: this.getUnrealizedPnL(currentPrice).toFixed(2),
        total: this.getTotalPnL(currentPrice).toFixed(2)
      },
      extremeFearBuys: this.extremeFearBuys.toFixed(6),
      fearBuys: this.fearBuys.toFixed(6),
      greedSells: this.greedSells.toFixed(6),
      extremeGreedSells: this.extremeGreedSells.toFixed(6),
      totalVolume: {
        sol: this.totalVolumeSol.toFixed(6),
        usdc: this.totalVolumeUsdc.toFixed(2),
        usd: totalVolumeUsd.toFixed(2)
      },
      balances: {
        sol: {
          initial: this.initialSolBalance.toFixed(6),
          current: this.solBalance.toFixed(6),
          traded: this.tradedSolBalance.toFixed(6)
        },
        usdc: {
          initial: this.initialUsdcBalance.toFixed(2),
          current: this.usdcBalance.toFixed(2),
          traded: this.tradedUsdcBalance.toFixed(2)
        }
      },
      averagePrices: {
        entry: this.getAverageEntryPrice().toFixed(2),
        sell: this.getAverageSellPrice().toFixed(2)
      },
      tradedValue: this.getTradedValue(currentPrice).toFixed(2)
    };
  }

  incrementCycle() {
    this.totalCycles++;
  }
}

module.exports = Position;