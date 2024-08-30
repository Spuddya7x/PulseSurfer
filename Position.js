class Position {
  constructor(initialSolBalance, initialUsdcBalance, initialPrice) {
    this.solBalance = initialSolBalance;
    this.usdcBalance = initialUsdcBalance;
    this.initialValue = this.solBalance * initialPrice + this.usdcBalance;
    this.initialSolBalance = initialSolBalance;
    this.initialUsdcBalance = initialUsdcBalance;
    this.initialPrice = initialPrice;
    this.trades = [];
    this.totalSolBought = 0;
    this.totalSolSold = 0;
    this.totalUsdcSpent = 0;
    this.totalUsdcReceived = 0;
    this.solBalanceFromTrades = 0;
    this.isInitialized = true;

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

  addTrade(tradeType, solAmount, usdcAmount, price, sentiment) {
    this.trades.push({
      type: tradeType,
      solAmount,
      usdcAmount,
      price,
      sentiment,
      timestamp: new Date()
    });

    if (tradeType === 'buy') {
      this.solBalance += solAmount;
      this.usdcBalance -= usdcAmount;
      this.totalSolBought += solAmount;
      this.totalUsdcSpent += usdcAmount;
      this.solBalanceFromTrades += solAmount;

      if (sentiment === 'EXTREME_FEAR') {
        this.extremeFearBuys += solAmount;
      } else if (sentiment === 'FEAR') {
        this.fearBuys += solAmount;
      }
    } else if (tradeType === 'sell') {
      this.solBalance -= solAmount;
      this.usdcBalance += usdcAmount;
      this.totalSolSold += solAmount;
      this.totalUsdcReceived += usdcAmount;

      if (sentiment === 'GREED') {
        this.greedSells += solAmount;
      } else if (sentiment === 'EXTREME_GREED') {
        this.extremeGreedSells += solAmount;
      }
    }

    this.totalVolumeSol += solAmount;
    this.totalVolumeUsdc += usdcAmount;
  }

  getAverageEntryPrice() {
    return this.totalSolBought > 0 ? this.totalUsdcSpent / this.totalSolBought : 0;
  }

  getAverageSellPrice() {
    return this.totalSolSold > 0 ? this.totalUsdcReceived / this.totalSolSold : 0;
  }

  getRealizedPnL() {
    const avgEntryPrice = this.getAverageEntryPrice();
    return avgEntryPrice > 0 ? this.totalUsdcReceived - (avgEntryPrice * this.totalSolSold) : 0;
  }

  getUnrealizedPnL(currentPrice) {
    const avgEntryPrice = this.getAverageEntryPrice();
    if (avgEntryPrice === 0) {
      return (currentPrice - this.initialPrice) * this.initialSolBalance;
    }
    return (currentPrice - avgEntryPrice) * this.solBalanceFromTrades;
  }

  getTotalPnL(currentPrice) {
    return this.getRealizedPnL() + this.getUnrealizedPnL(currentPrice);
  }

  getCurrentValue(currentPrice) {
    return this.solBalance * currentPrice + this.usdcBalance;
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
          current: this.solBalance.toFixed(6)
        },
        usdc: {
          initial: this.initialUsdcBalance.toFixed(2),
          current: this.usdcBalance.toFixed(2)
        }
      },
      averagePrices: {
        entry: this.getAverageEntryPrice().toFixed(2),
        sell: this.getAverageSellPrice().toFixed(2)
      }
    };
  }

  incrementCycle() {
    this.totalCycles++;
  }
}

module.exports = Position;