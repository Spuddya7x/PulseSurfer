class Position {
  constructor(initialSolBalance, initialUsdcBalance, initialPrice) {
    this.solBalance = initialSolBalance;
    this.usdcBalance = initialUsdcBalance;
    this.initialValue = this.solBalance * initialPrice + this.usdcBalance;
    this.initialSolBalance = initialSolBalance;
    this.initialPrice = initialPrice;
    this.trades = [];
    this.totalSolBought = 0;
    this.totalSolSold = 0;
    this.totalUsdcSpent = 0;
    this.totalUsdcReceived = 0;
    this.solBalanceFromTrades = 0;
    this.isInitialized = true;

    // New properties for enhanced statistics
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
    // ... (existing code remains the same)
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
    const currentValue = this.getCurrentValue(currentPrice);
    return currentValue - this.initialValue;
  }

  getCurrentValue(currentPrice) {
    return this.solBalance * currentPrice + this.usdcBalance;
  }

  getPerformanceMetrics(currentPrice) {
    const currentValue = this.getCurrentValue(currentPrice);
    const totalPnL = this.getTotalPnL(currentPrice);
    const percentageReturn = (totalPnL / this.initialValue) * 100;
    const avgEntryPrice = this.getAverageEntryPrice();

    return {
      currentValue: currentValue.toFixed(2),
      totalPnL: totalPnL.toFixed(2),
      percentageReturn: percentageReturn.toFixed(2),
      realizedPnL: this.getRealizedPnL().toFixed(2),
      unrealizedPnL: this.getUnrealizedPnL(currentPrice).toFixed(2),
      averageEntryPrice: avgEntryPrice > 0 ? avgEntryPrice.toFixed(2) : 'N/A',
      averageSellPrice: this.getAverageSellPrice().toFixed(2),
      solBalance: this.solBalance.toFixed(6),
      usdcBalance: this.usdcBalance.toFixed(2)
    };
  }

  getEnhancedStatistics(currentPrice) {
    const currentPortfolioValue = this.getCurrentValue(currentPrice);
    const portfolioChange = currentPortfolioValue - this.initialValue;
    const totalRuntime = (Date.now() - this.startTime) / 1000 / 60 / 60; // in hours
    const totalVolumeUsd = this.totalVolumeUsdc + (this.totalVolumeSol * currentPrice);

    return {
      totalRuntime: totalRuntime.toFixed(2),
      totalCycles: this.totalCycles,
      portfolioChange: {
        start: this.initialValue.toFixed(2),
        current: currentPortfolioValue.toFixed(2),
        change: portfolioChange.toFixed(2)
      },
      extremeFearBuys: this.extremeFearBuys.toFixed(6),
      fearBuys: this.fearBuys.toFixed(6),
      greedSells: this.greedSells.toFixed(6),
      extremeGreedSells: this.extremeGreedSells.toFixed(6),
      totalVolume: {
        sol: this.totalVolumeSol.toFixed(6),
        usdc: this.totalVolumeUsdc.toFixed(2),
        usd: totalVolumeUsd.toFixed(2)
      }
    };
  }

  incrementCycle() {
    this.totalCycles++;
  }
}

module.exports = Position;