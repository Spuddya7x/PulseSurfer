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
    this.totalSolBought = 0;
    this.totalUsdcSpent = 0;
    this.totalSolSold = 0;
    this.totalUsdcReceived = 0;

    // Enhanced statistics
    this.startTime = Date.now();
    this.totalCycles = 0;
    this.totalVolumeSol = 0;
    this.totalVolumeUsdc = 0;
  }

  updateBalances(newSolBalance, newUsdcBalance) {
    this.solBalance = newSolBalance;
    this.usdcBalance = newUsdcBalance;
  }

  logTrade(sentiment, price, solChange, usdcChange) {
    const tradeType = solChange > 0 ? 'buy' : 'sell';
    const solAmount = Math.abs(solChange);
    const usdcAmount = Math.abs(usdcChange);

    this.trades.push({
      type: tradeType,
      solAmount,
      usdcAmount,
      price,
      sentiment,
      timestamp: new Date()
    });

    // Update traded amounts
    if (tradeType === 'buy') {
      this.totalSolBought += solAmount;
      this.totalUsdcSpent += usdcAmount;
    } else {
      this.totalSolSold += solAmount;
      this.totalUsdcReceived += usdcAmount;
    }

    // Update total volume
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
    return this.totalUsdcReceived - this.totalUsdcSpent;
  }

  getUnrealizedPnL(currentPrice) {
    const currentSolValue = (this.totalSolBought - this.totalSolSold) * currentPrice;
    return currentSolValue - (this.totalUsdcSpent - this.totalUsdcReceived);
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
      totalVolume: {
        sol: this.totalVolumeSol.toFixed(6),
        usdc: this.totalVolumeUsdc.toFixed(2),
        usd: totalVolumeUsd.toFixed(2)
      },
      balances: {
        sol: {
          initial: this.initialSolBalance.toFixed(6),
          current: this.solBalance.toFixed(6),
          traded: (this.totalSolBought - this.totalSolSold).toFixed(6)
        },
        usdc: {
          initial: this.initialUsdcBalance.toFixed(2),
          current: this.usdcBalance.toFixed(2),
          traded: (this.totalUsdcSpent - this.totalUsdcReceived).toFixed(2)
        }
      },
      averagePrices: {
        entry: this.getAverageEntryPrice().toFixed(2),
        sell: this.getAverageSellPrice().toFixed(2)
      },
      tradedValue: (this.totalUsdcSpent + this.totalUsdcReceived).toFixed(2)
    };
  }

  incrementCycle() {
    this.totalCycles++;
  }
}

module.exports = Position;