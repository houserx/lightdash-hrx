# Grafana panel mapping

Where every Grafana panel type and every panel option used by HouseRx's 32 Grafana dashboards lands in Lightdash, or
why it is dropped. The panel types and option paths come from the infra snapshot
(`houserx/infra@bf3093da`, `terraform-tooling/grafana_config/**/*.json`). Only option paths were taken, never values.

The source of truth is the typed module
[`packages/common/src/eng1799/grafanaPanelMapping.ts`](../../packages/common/src/eng1799/grafanaPanelMapping.ts):

- `getGrafanaPanelMapping(type)` returns where a panel type lands.
- `getGrafanaPanelOptionMapping(type, path)` returns where a panel option lands.

The dashboard importer reads the module. The tables below were written from it, and every target, Lightdash path,
note and reason is the module's own. If the two disagree, the module is right and this page needs updating.

## Panel types

Each panel type goes to one of six kinds of target:

- **built-in chart**: a saved chart with one of Lightdash's own chart types (cartesian, gauge, table, pie).
- **native chart**: a saved chart with a chart type added for ENG-1799 (log stream, trace waterfall).
- **registry chart**: a `ChartType.CUSTOM` chart drawn by an entry from the HouseRx chart registry (`chart-registry/`).
- **markdown tile**: a dashboard markdown tile.
- **heading tile**: a dashboard heading tile, used as a section header.
- **dropped**: not imported. The reason column says why.

| Grafana type | Target         | Lightdash                                           | Note or reason                                                                                                                                       |
| ------------ | -------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alertlist`  | dropped        | —                                                   | Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile.                                     |
| `barchart`   | built-in chart | `ChartType.CARTESIAN`                               | Cartesian chart with bar series.                                                                                                                     |
| `bargauge`   | registry chart | `ChartType.CUSTOM`, registry entry `bar-gauge`      |                                                                                                                                                      |
| `dashlist`   | dropped        | —                                                   | Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `gauge`      | built-in chart | `ChartType.GAUGE`                                   |                                                                                                                                                      |
| `graph`      | built-in chart | `ChartType.CARTESIAN`                               | Legacy Grafana graph panel; converts like timeseries.                                                                                                |
| `logs`       | native chart   | `ChartType.LOG_STREAM`                              |                                                                                                                                                      |
| `news`       | dropped        | —                                                   | Shows an external RSS feed (the Grafana blog), not query data, so there is nothing to chart.                                                         |
| `piechart`   | built-in chart | `ChartType.PIE`                                     |                                                                                                                                                      |
| `row`        | heading tile   | heading tile                                        | The row title becomes a heading tile above the panels it holds.                                                                                      |
| `stat`       | registry chart | `ChartType.CUSTOM`, registry entry `stat-sparkline` |                                                                                                                                                      |
| `table`      | built-in chart | `ChartType.TABLE`                                   |                                                                                                                                                      |
| `table-old`  | built-in chart | `ChartType.TABLE`                                   | Legacy Grafana table panel; converts like table.                                                                                                     |
| `text`       | markdown tile  | markdown tile                                       | The panel content becomes the markdown tile content.                                                                                                 |
| `timeseries` | built-in chart | `ChartType.CARTESIAN`                               | Cartesian chart with line series over a time x axis.                                                                                                 |

## Panel options

Option paths are JSON paths inside the Grafana panel, such as `options.wrapLogMessage` or
`fieldConfig.defaults.unit`. `fieldConfig.overrides.<key>` stands for an override property with that id, with
`custom.<key>` used for `custom.*` ids. An option goes to one of these targets:

- **builtin chart config**: a key in a built-in chart type's config (`CartesianChart`, `GaugeChart`, `TableChart`,
  `PieChart`).
- **native chart config**: a key in an ENG-1799 chart type's config (`LogStreamChart`, `TraceWaterfallChart`).
- **registry option**: a config option of the registry entry, in the chart's `optionValues`.
- **field format**: the field's number format, in `metricQuery.metricOverrides[field].formatOptions`.
- **tile**: a property of the dashboard tile or of the saved chart itself.
- **dropped**: not imported. The reason column says why.

The options of the three dropped panel types (`alertlist`, `dashlist`, `news`) are listed too. Each is dropped
together with its panel.

### Every panel type (`*`)

These panel-level keys can appear on any panel. The table shows where they land for a chart panel (`timeseries`). `text` and `row` override `description`, `row` also overrides `collapsed`, and on the three dropped panel types every option is dropped with the panel.

| Option path        | Target  | Lightdash                | Note or reason                                                                                                                                      |
| ------------------ | ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collapsed`        | dropped | —                        | Only Grafana rows collapse; other panels ignore it.                                                                                                 |
| `description`      | tile    | `SavedChart.description` | Shown in the chart tile’s description tooltip.                                                                                                      |
| `hideTimeOverride` | dropped | —                        | Only hides the time override badge, and time overrides are dropped.                                                                                 |
| `interval`         | dropped | —                        | Lightdash buckets time by the time dimension’s interval (for example \_minute), which the importer picks when it converts the query.                |
| `links`            | dropped | —                        | Lightdash charts have no per-panel link menu, and links to Grafana dashboards stop working at Cutover.                                              |
| `maxDataPoints`    | dropped | —                        | Lightdash limits rows with the query limit, which the importer sets when it converts the query.                                                     |
| `timeFrom`         | dropped | —                        | Lightdash tiles have no per-tile time override; dashboard filters apply to the whole dashboard.                                                     |
| `timeShift`        | dropped | —                        | Lightdash tiles have no per-tile time shift; dashboard filters apply to the whole dashboard.                                                        |
| `transformations`  | dropped | —                        | Grafana transformations reshape data in the browser; Lightdash shapes data in the query, which the importer does not generate from transformations. |

### `alertlist` options

| Option path                        | Target  | Lightdash | Note or reason                                                                                                                                        |
| ---------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.alertInstanceLabelFilter` | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.alertName`                | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.dashboardAlerts`          | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.groupBy`                  | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.groupMode`                | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.maxItems`                 | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.sortOrder`                | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.stateFilter.error`        | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.stateFilter.firing`       | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.stateFilter.noData`       | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.stateFilter.normal`       | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.stateFilter.pending`      | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |
| `options.viewMode`                 | dropped | —         | The alertlist panel is not imported: Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile. |

### `barchart` options

| Option path                                          | Target               | Lightdash                           | Note or reason                                                                                                    |
| ---------------------------------------------------- | -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `fieldConfig.defaults.color.mode`                    | builtin chart config | `eChartsConfig.series[].color`      | fixed sets each series colour to color.fixedColor; palette and threshold schemes use the project colour palette.  |
| `fieldConfig.defaults.custom.axisBorderShow`         | dropped              | —                                   | Lightdash draws its own axis lines; there is no per-axis border switch.                                           |
| `fieldConfig.defaults.custom.axisCenteredZero`       | dropped              | —                                   | Lightdash axes have no centred-zero mode; min and max are fixed numbers or automatic.                             |
| `fieldConfig.defaults.custom.axisColorMode`          | dropped              | —                                   | Axis colours follow the Lightdash theme, not the series colour.                                                   |
| `fieldConfig.defaults.custom.axisLabel`              | builtin chart config | `eChartsConfig.yAxis[].name`        |                                                                                                                   |
| `fieldConfig.defaults.custom.axisPlacement`          | builtin chart config | `eChartsConfig.series[].yAxisIndex` | left is axis 0 and right is axis 1; hidden sets layout.showYAxis to false.                                        |
| `fieldConfig.defaults.custom.axisSoftMax`            | builtin chart config | `eChartsConfig.yAxis[].max`         | Lightdash max is hard: values above it are clipped, where Grafana would extend the axis.                          |
| `fieldConfig.defaults.custom.fillOpacity`            | builtin chart config | `eChartsConfig.series[].areaStyle`  | A line series with fillOpacity above 0 becomes an area series; the opacity itself is not kept.                    |
| `fieldConfig.defaults.custom.gradientMode`           | dropped              | —                                   | Lightdash area and bar fills are flat.                                                                            |
| `fieldConfig.defaults.custom.hideFrom.legend`        | dropped              | —                                   | Lightdash cannot hide a drawn series from the legend alone.                                                       |
| `fieldConfig.defaults.custom.hideFrom.tooltip`       | dropped              | —                                   | Lightdash cannot hide a drawn series from the tooltip alone.                                                      |
| `fieldConfig.defaults.custom.hideFrom.viz`           | builtin chart config | `eChartsConfig.series[].hidden`     |                                                                                                                   |
| `fieldConfig.defaults.custom.lineWidth`              | dropped              | —                                   | Lightdash draws series lines at a fixed width.                                                                    |
| `fieldConfig.defaults.custom.scaleDistribution.type` | dropped              | —                                   | Lightdash value axes are linear; log scales are not available.                                                    |
| `fieldConfig.defaults.custom.thresholdsStyle.mode`   | builtin chart config | `thresholds.style`                  | line, dashed, area, line+area and dashed+area keep their names; off drops the thresholds.                         |
| `fieldConfig.defaults.mappings`                      | dropped              | —                                   | Cartesian charts do not apply value mappings; only tables and the stat entry do.                                  |
| `fieldConfig.defaults.thresholds.mode`               | builtin chart config | `thresholds.mode`                   |                                                                                                                   |
| `fieldConfig.defaults.thresholds.steps`              | builtin chart config | `thresholds.steps`                  | Kept only when thresholdsStyle.mode draws them.                                                                   |
| `options.barRadius`                                  | dropped              | —                                   | Lightdash bars have square corners.                                                                               |
| `options.barWidth`                                   | dropped              | —                                   | Bar width follows the category width; Lightdash has no bar width option.                                          |
| `options.fullHighlight`                              | dropped              | —                                   | Lightdash highlights the hovered bar only.                                                                        |
| `options.groupWidth`                                 | dropped              | —                                   | Lightdash has no bar group width option.                                                                          |
| `options.legend.calcs`                               | dropped              | —                                   | Lightdash legends show series names only, not per-series statistics.                                              |
| `options.legend.displayMode`                         | builtin chart config | `eChartsConfig.legend.show`         | hidden is false; list and table are true (table shows as a list).                                                 |
| `options.legend.placement`                           | builtin chart config | `eChartsConfig.legend.placement`    | bottom keeps the default legend position; right is 'outsideRight'.                                                |
| `options.legend.showLegend`                          | builtin chart config | `eChartsConfig.legend.show`         |                                                                                                                   |
| `options.orientation`                                | builtin chart config | `layout.flipAxes`                   | horizontal is true; vertical and auto are false.                                                                  |
| `options.showValue`                                  | builtin chart config | `eChartsConfig.series[].label.show` | always and auto are true; never is false.                                                                         |
| `options.stacking`                                   | builtin chart config | `layout.stack`                      | normal stacks; percent also stacks, but as absolute values (Lightdash has no 100% stacking); none does not stack. |
| `options.text`                                       | dropped              | —                                   | Value label font sizes are fixed in Lightdash.                                                                    |
| `options.tooltip.mode`                               | dropped              | —                                   | Lightdash tooltips always list every series at the hovered x (Grafana's all mode).                                |
| `options.tooltip.sort`                               | builtin chart config | `eChartsConfig.tooltipSort`         | asc is value_ascending, desc is value_descending, none is default.                                                |
| `options.xTickLabelRotation`                         | builtin chart config | `eChartsConfig.xAxis[].rotate`      |                                                                                                                   |
| `options.xTickLabelSpacing`                          | dropped              | —                                   | ECharts spaces x axis labels itself; there is no spacing option.                                                  |

### `bargauge` options

| Option path                             | Target          | Lightdash                  | Note or reason                                                                            |
| --------------------------------------- | --------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `fieldConfig.defaults.color.mode`       | registry option | `optionValues.thresholds`  | The bars always take their threshold colours; other colour modes keep the steps.          |
| `fieldConfig.defaults.mappings`         | dropped         | —                          | The bar-gauge entry shows numbers; it does not apply value mappings.                      |
| `fieldConfig.defaults.max`              | registry option | `optionValues.max`         |                                                                                           |
| `fieldConfig.defaults.thresholds.mode`  | registry option | `optionValues.thresholds`  | The registry option takes the Grafana thresholds as JSON ({ mode, steps }).               |
| `fieldConfig.defaults.thresholds.steps` | registry option | `optionValues.thresholds`  | The registry option takes the Grafana thresholds as JSON ({ mode, steps }).               |
| `fieldConfig.defaults.unit`             | registry option | `optionValues.unit`        |                                                                                           |
| `options.displayMode`                   | registry option | `optionValues.displayMode` | basic and gradient are kept; lcd becomes gradient.                                        |
| `options.maxVizHeight`                  | dropped         | —                          | Grafana layout sizing; the tile size comes from the panel gridPos.                        |
| `options.minVizHeight`                  | dropped         | —                          | Grafana layout sizing; the tile size comes from the panel gridPos.                        |
| `options.minVizWidth`                   | dropped         | —                          | Grafana layout sizing; the tile size comes from the panel gridPos.                        |
| `options.namePlacement`                 | dropped         | —                          | The bar-gauge entry places names in one fixed spot.                                       |
| `options.orientation`                   | registry option | `optionValues.orientation` | horizontal and vertical are kept; auto becomes horizontal.                                |
| `options.reduceOptions`                 | dropped         | —                          | The bar-gauge entry draws one bar per row, so the reduction (calcs) moves into the query. |
| `options.showUnfilled`                  | dropped         | —                          | The bar-gauge entry always draws the unfilled track.                                      |
| `options.sizing`                        | dropped         | —                          | Grafana layout sizing; the tile size comes from the panel gridPos.                        |
| `options.valueMode`                     | dropped         | —                          | The bar-gauge entry always colours the value text with the theme.                         |

### `dashlist` options

| Option path                  | Target  | Lightdash | Note or reason                                                                                                                                                                           |
| ---------------------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.includeVars`        | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.keepTime`           | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.maxItems`           | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.query`              | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.showFolderNames`    | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.showHeadings`       | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.showRecentlyViewed` | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.showSearch`         | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.showStarred`        | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |
| `options.tags`               | dropped | —         | The dashlist panel is not imported: Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover. |

### `gauge` options

| Option path                             | Target               | Lightdash                                                | Note or reason                                                                                                |
| --------------------------------------- | -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `fieldConfig.defaults.color.mode`       | dropped              | —                                                        | Lightdash gauges are coloured by their sections (from the thresholds); other colour modes have no equivalent. |
| `fieldConfig.defaults.decimals`         | field format         | `metricQuery.metricOverrides[field].formatOptions.round` | Passed as the decimals of grafanaUnitToCustomFormat.                                                          |
| `fieldConfig.defaults.mappings`         | dropped              | —                                                        | Lightdash gauges show the number; value mappings are not applied.                                             |
| `fieldConfig.defaults.max`              | builtin chart config | `max`                                                    |                                                                                                               |
| `fieldConfig.defaults.min`              | builtin chart config | `min`                                                    |                                                                                                               |
| `fieldConfig.defaults.thresholds.mode`  | builtin chart config | `sections`                                               | Percentage steps are resolved against min..max by grafanaThresholdsToGaugeSections.                           |
| `fieldConfig.defaults.thresholds.steps` | builtin chart config | `sections`                                               | grafanaThresholdsToGaugeSections turns the steps into coloured sections.                                      |
| `fieldConfig.defaults.unit`             | field format         | `metricQuery.metricOverrides[field].formatOptions`       | grafanaUnitToCustomFormat(unit, { decimals }).                                                                |
| `fieldConfig.defaults.unitScale`        | dropped              | —                                                        | grafanaUnitToCustomFormat already picks the compact scale for each unit; there is no separate switch.         |
| `options.minVizHeight`                  | dropped              | —                                                        | Grafana layout sizing; the tile size comes from the panel gridPos.                                            |
| `options.minVizWidth`                   | dropped              | —                                                        | Grafana layout sizing; the tile size comes from the panel gridPos.                                            |
| `options.orientation`                   | dropped              | —                                                        | Only lays out several gauges; a Lightdash gauge shows one value.                                              |
| `options.reduceOptions`                 | builtin chart config | `selectedField`                                          | The gauge reads the first row of selectedField, so the reduction (calcs) moves into the query.                |
| `options.showThresholdLabels`           | dropped              | —                                                        | Lightdash gauges label min and max only (showAxisLabels), not each threshold.                                 |
| `options.showThresholdMarkers`          | builtin chart config | `sections`                                               | false leaves sections empty; true keeps the threshold sections.                                               |
| `options.sizing`                        | dropped              | —                                                        | Grafana layout sizing; the tile size comes from the panel gridPos.                                            |

### `graph` options

| Option path                  | Target               | Lightdash                           | Note or reason                                                                                                         |
| ---------------------------- | -------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `aliasColors`                | builtin chart config | `eChartsConfig.series[].color`      | Each alias colour is set on the series with that name.                                                                 |
| `bars`                       | builtin chart config | `eChartsConfig.series[].type`       | true makes bar series.                                                                                                 |
| `dashLength`                 | dropped              | —                                   | Lightdash series lines are always solid; dashed lines are not available.                                               |
| `dashes`                     | dropped              | —                                   | Lightdash series lines are always solid; dashed lines are not available.                                               |
| `fieldConfig.defaults.links` | dropped              | —                                   | Lightdash charts have no per-panel link menu, and links to Grafana dashboards stop working at Cutover.                 |
| `fill`                       | builtin chart config | `eChartsConfig.series[].areaStyle`  | A fill above 0 makes line series area series; the fill level is not kept.                                              |
| `fillGradient`               | dropped              | —                                   | Lightdash area fills are flat.                                                                                         |
| `hiddenSeries`               | builtin chart config | `eChartsConfig.series[].hidden`     |                                                                                                                        |
| `legend`                     | builtin chart config | `eChartsConfig.legend.show`         | legend.show is kept; the value columns (min, max, avg, current) are dropped.                                           |
| `lines`                      | builtin chart config | `eChartsConfig.series[].type`       | true makes line series.                                                                                                |
| `linewidth`                  | dropped              | —                                   | Lightdash draws series lines at a fixed width.                                                                         |
| `nullPointMode`              | builtin chart config | `layout.connectNulls`               | connected is true; null and null as zero are false.                                                                    |
| `options.alertThreshold`     | dropped              | —                                   | Draws legacy Grafana alert thresholds; Alert Rules move to Lightdash (ADR 0001).                                       |
| `percentage`                 | dropped              | —                                   | Lightdash has no 100% stacking; the series stack as absolute values.                                                   |
| `pointradius`                | dropped              | —                                   | Lightdash draws point symbols at a fixed size.                                                                         |
| `points`                     | builtin chart config | `eChartsConfig.series[].showSymbol` |                                                                                                                        |
| `renderer`                   | dropped              | —                                   | Grafana rendering backend (flot); not a chart setting.                                                                 |
| `seriesOverrides`            | builtin chart config | `eChartsConfig.series[]`            | Per alias: color, yaxis (yAxisIndex), bars or lines (type), stack and hidden; other keys are dropped.                  |
| `spaceLength`                | dropped              | —                                   | Lightdash series lines are always solid; dashed lines are not available.                                               |
| `stack`                      | builtin chart config | `layout.stack`                      |                                                                                                                        |
| `steppedLine`                | dropped              | —                                   | Lightdash has no stepped lines; they draw linear.                                                                      |
| `thresholds`                 | builtin chart config | `thresholds`                        | Each legacy threshold becomes a step; fill draws area and line draws line.                                             |
| `timeRegions`                | dropped              | —                                   | Lightdash charts have no time-of-day region shading.                                                                   |
| `tooltip`                    | builtin chart config | `eChartsConfig.tooltipSort`         | sort 1 is value_ascending, 2 is value_descending, 0 is default; shared and value_type are dropped.                     |
| `xaxis`                      | builtin chart config | `layout.showXAxis`                  | xaxis.show is kept; the x axis is the time dimension.                                                                  |
| `yaxes`                      | builtin chart config | `eChartsConfig.yAxis[]`             | label is name, min and max are kept, show is layout.showLeftYAxis/showRightYAxis, and format becomes the field format. |
| `yaxis`                      | dropped              | —                                   | Lines up zero on the left and right y axes; Lightdash has no axis alignment.                                           |

### `logs` options

| Option path                  | Target              | Lightdash                    | Note or reason                                                                       |
| ---------------------------- | ------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `options.dedupStrategy`      | dropped             | —                            | The log stream shows every line; it does not deduplicate.                            |
| `options.enableLogDetails`   | dropped             | —                            | Every log stream line can be expanded to show its details.                           |
| `options.prettifyLogMessage` | dropped             | —                            | The log stream shows each line as stored.                                            |
| `options.showCommonLabels`   | dropped             | —                            | The log stream has no common labels header.                                          |
| `options.showLabels`         | native chart config | `LogStreamChart.showLabels`  |                                                                                      |
| `options.showTime`           | dropped             | —                            | The log stream always shows each line’s timestamp (LogStreamChart.timestampFieldId). |
| `options.sortOrder`          | native chart config | `LogStreamChart.newestFirst` | Descending is true; Ascending is false.                                              |
| `options.wrapLogMessage`     | native chart config | `LogStreamChart.wrapLines`   |                                                                                      |

### `news` options

| Option path         | Target  | Lightdash | Note or reason                                                                                                               |
| ------------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `options.feedUrl`   | dropped | —         | The news panel is not imported: Shows an external RSS feed (the Grafana blog), not query data, so there is nothing to chart. |
| `options.showImage` | dropped | —         | The news panel is not imported: Shows an external RSS feed (the Grafana blog), not query data, so there is nothing to chart. |

### `piechart` options

| Option path                                    | Target               | Lightdash             | Note or reason                                                                                       |
| ---------------------------------------------- | -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `fieldConfig.defaults.color.mode`              | dropped              | —                     | Pie slices use the project colour palette unless overridden per slice (fieldConfig.overrides.color). |
| `fieldConfig.defaults.custom.hideFrom.legend`  | dropped              | —                     | Lightdash pies cannot hide a slice from the legend alone.                                            |
| `fieldConfig.defaults.custom.hideFrom.tooltip` | dropped              | —                     | Lightdash pies cannot hide a slice from the tooltip alone.                                           |
| `fieldConfig.defaults.custom.hideFrom.viz`     | dropped              | —                     | Lightdash pies draw every group the query returns; filter the query instead.                         |
| `fieldConfig.defaults.mappings`                | builtin chart config | `groupLabelOverrides` | Value-to-text mappings rename the matching slices; range, regex and special mappings are dropped.    |
| `fieldConfig.overrides.color`                  | builtin chart config | `groupColorOverrides` | Set on each slice the override matches, resolved with resolveGrafanaColor.                           |
| `options.displayLabels`                        | builtin chart config | `showValue`           | value sets showValue, percent sets showPercentage; name is shown in the legend and tooltip.          |
| `options.legend.displayMode`                   | builtin chart config | `showLegend`          | hidden is false; list and table are true.                                                            |
| `options.legend.placement`                     | builtin chart config | `legendPosition`      | bottom is horizontal; right is vertical.                                                             |
| `options.legend.showLegend`                    | builtin chart config | `showLegend`          |                                                                                                      |
| `options.legend.values`                        | dropped              | —                     | Lightdash pie legends show slice names only.                                                         |
| `options.pieType`                              | builtin chart config | `isDonut`             | donut is true; pie is false.                                                                         |
| `options.reduceOptions`                        | builtin chart config | `metricId`            | Each slice is one row of metricId, so the reduction (calcs) moves into the query.                    |
| `options.tooltip.mode`                         | dropped              | —                     | Lightdash tooltips are not configurable per chart.                                                   |
| `options.tooltip.sort`                         | dropped              | —                     | Lightdash tooltips are not configurable per chart.                                                   |

### `stat` options

| Option path                             | Target          | Lightdash                    | Note or reason                                                                                         |
| --------------------------------------- | --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `fieldConfig.defaults.color.fixedColor` | registry option | `optionValues.thresholds`    | A fixed colour becomes a single base step in that colour.                                              |
| `fieldConfig.defaults.color.mode`       | registry option | `optionValues.thresholds`    | thresholds keeps the steps; fixed becomes a single base step; palette modes keep the steps.            |
| `fieldConfig.defaults.color.seriesBy`   | dropped         | —                            | Only matters for Grafana gradient colour schemes, which Lightdash does not have.                       |
| `fieldConfig.defaults.decimals`         | registry option | `optionValues.decimals`      |                                                                                                        |
| `fieldConfig.defaults.fieldMinMax`      | dropped         | —                            | Only sets per-field colour scale ranges, which Lightdash does not have.                                |
| `fieldConfig.defaults.links`            | dropped         | —                            | Lightdash charts have no per-panel link menu, and links to Grafana dashboards stop working at Cutover. |
| `fieldConfig.defaults.mappings`         | registry option | `optionValues.valueMappings` | The registry option takes the Grafana mappings as JSON.                                                |
| `fieldConfig.defaults.max`              | dropped         | —                            | The stat entry has no min or max; in Grafana they only scale percentage thresholds and the sparkline.  |
| `fieldConfig.defaults.min`              | dropped         | —                            | The stat entry has no min or max; in Grafana they only scale percentage thresholds and the sparkline.  |
| `fieldConfig.defaults.noValue`          | dropped         | —                            | The stat entry shows "No data" when there is no value.                                                 |
| `fieldConfig.defaults.thresholds.mode`  | registry option | `optionValues.thresholds`    | The registry option takes the Grafana thresholds as JSON ({ mode, steps }).                            |
| `fieldConfig.defaults.thresholds.steps` | registry option | `optionValues.thresholds`    | The registry option takes the Grafana thresholds as JSON ({ mode, steps }).                            |
| `fieldConfig.defaults.unit`             | registry option | `optionValues.unit`          |                                                                                                        |
| `fieldConfig.defaults.unitScale`        | dropped         | —                            | grafanaUnitToCustomFormat already picks the compact scale for each unit; there is no separate switch.  |
| `fieldConfig.overrides.color`           | dropped         | —                            | The stat entry shows one value; its colour comes from the thresholds and value mappings.               |
| `options.colorMode`                     | registry option | `optionValues.colorMode`     | value, background and none are kept; background_solid becomes background.                              |
| `options.graphMode`                     | registry option | `optionValues.graphMode`     |                                                                                                        |
| `options.justifyMode`                   | dropped         | —                            | The stat entry always centres its value.                                                               |
| `options.orientation`                   | dropped         | —                            | Only lays out several values; the stat entry shows one.                                                |
| `options.percentChangeColorMode`        | dropped         | —                            | The stat entry does not show a percent change.                                                         |
| `options.reduceOptions`                 | registry option | `optionValues.reducer`       | reduceOptions.calcs[0] is the reducer; values and fields are dropped.                                  |
| `options.showPercentChange`             | dropped         | —                            | The stat entry does not show a percent change.                                                         |
| `options.text`                          | dropped         | —                            | The stat entry sizes its text to the tile.                                                             |
| `options.textMode`                      | dropped         | —                            | The stat entry shows the value only; names come from the tile title.                                   |
| `options.wideLayout`                    | dropped         | —                            | The stat entry has one layout.                                                                         |

### `table` options

| Option path                                        | Target               | Lightdash                                                | Note or reason                                                                                                                                     |
| -------------------------------------------------- | -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fieldConfig.defaults.color.mode`                  | builtin chart config | `conditionalFormattings`                                 | thresholds mode colours cells by the threshold steps; other modes are dropped.                                                                     |
| `fieldConfig.defaults.custom.align`                | dropped              | —                                                        | Lightdash aligns numbers right and text left.                                                                                                      |
| `fieldConfig.defaults.custom.cellOptions.type`     | builtin chart config | `columns[field].displayStyle`                            | gauge and bar modes are bar; colour-text and colour-background modes become conditionalFormattings; auto is text.                                  |
| `fieldConfig.defaults.custom.cellOptions.wrapText` | dropped              | —                                                        | Lightdash table cells do not wrap text.                                                                                                            |
| `fieldConfig.defaults.custom.displayMode`          | builtin chart config | `columns[field].displayStyle`                            | Older name for cellOptions.type: gauge and bar modes are bar; colour-text and colour-background modes become conditionalFormattings; auto is text. |
| `fieldConfig.defaults.custom.filterable`           | dropped              | —                                                        | Lightdash filters come from the dashboard filters, not column filter menus.                                                                        |
| `fieldConfig.defaults.custom.inspect`              | dropped              | —                                                        | Lightdash has no cell inspect view; long values show in the cell tooltip.                                                                          |
| `fieldConfig.defaults.custom.minWidth`             | builtin chart config | `columns[field].width`                                   | The minimum width becomes the fixed column width.                                                                                                  |
| `fieldConfig.defaults.decimals`                    | field format         | `metricQuery.metricOverrides[field].formatOptions.round` | Passed as the decimals of grafanaUnitToCustomFormat.                                                                                               |
| `fieldConfig.defaults.links`                       | dropped              | —                                                        | Lightdash charts have no per-panel link menu, and links to Grafana dashboards stop working at Cutover.                                             |
| `fieldConfig.defaults.mappings`                    | builtin chart config | `columns[field].valueMappings`                           | Copied to every column the panel shows.                                                                                                            |
| `fieldConfig.defaults.noValue`                     | dropped              | —                                                        | Lightdash shows its own empty-result message; there is no custom no-value text.                                                                    |
| `fieldConfig.defaults.thresholds.mode`             | builtin chart config | `conditionalFormattings`                                 | Kept only when a colour cell type or colour mode uses the thresholds.                                                                              |
| `fieldConfig.defaults.thresholds.steps`            | builtin chart config | `conditionalFormattings`                                 | Each step becomes a range rule in its colour, when a colour cell type or colour mode uses them.                                                    |
| `fieldConfig.defaults.unit`                        | field format         | `metricQuery.metricOverrides[field].formatOptions`       | grafanaUnitToCustomFormat(unit, { decimals }).                                                                                                     |
| `fieldConfig.overrides.custom.hidden`              | builtin chart config | `columns[field].visible`                                 | hidden: true is visible: false.                                                                                                                    |
| `fieldConfig.overrides.custom.width`               | builtin chart config | `columns[field].width`                                   |                                                                                                                                                    |
| `fieldConfig.overrides.decimals`                   | field format         | `metricQuery.metricOverrides[field].formatOptions.round` | Set on each field the override matches.                                                                                                            |
| `options.cellHeight`                               | dropped              | —                                                        | Lightdash table rows have one height.                                                                                                              |
| `options.footer.countRows`                         | builtin chart config | `showResultsTotal`                                       | Lightdash shows the row count as the results total.                                                                                                |
| `options.footer.enablePagination`                  | dropped              | —                                                        | Lightdash tables always paginate.                                                                                                                  |
| `options.footer.fields`                            | dropped              | —                                                        | Lightdash totals every numeric column; the field list is not kept.                                                                                 |
| `options.footer.reducer`                           | builtin chart config | `showColumnCalculation`                                  | Lightdash column totals are sums; other reducers show as sums.                                                                                     |
| `options.footer.show`                              | builtin chart config | `showColumnCalculation`                                  |                                                                                                                                                    |
| `options.frameIndex`                               | dropped              | —                                                        | A Lightdash chart has one result set; the importer picks the frame when it converts the query.                                                     |
| `options.showHeader`                               | dropped              | —                                                        | Lightdash tables always show a header.                                                                                                             |
| `options.sortBy`                                   | dropped              | —                                                        | The table shows rows in query order; the default sort becomes the query sorts (metricQuery.sorts), not table config.                               |

### `table-old` options

| Option path  | Target               | Lightdash                | Note or reason                                                                                                                                        |
| ------------ | -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `columns`    | builtin chart config | `columns[field].visible` | Listed columns are visible; the rest are hidden.                                                                                                      |
| `fontSize`   | dropped              | —                        | Lightdash tables use one font size.                                                                                                                   |
| `scroll`     | dropped              | —                        | Lightdash tables always scroll inside the tile.                                                                                                       |
| `showHeader` | dropped              | —                        | Lightdash tables always show a header.                                                                                                                |
| `sort`       | dropped              | —                        | The table shows rows in query order; the default sort becomes the query sorts (metricQuery.sorts), not table config.                                  |
| `styles`     | builtin chart config | `columns[field]`         | alias is name and type hidden is visible: false; unit and decimals become the field format, and thresholds with colors become conditionalFormattings. |
| `transform`  | dropped              | —                        | Reshapes the result in the browser (timeseries to rows or columns); the query returns the shape instead.                                              |

### `text` options

| Option path                    | Target  | Lightdash                                            | Note or reason                                                                                      |
| ------------------------------ | ------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `editable`                     | dropped | —                                                    | Grafana editor state, not content.                                                                  |
| `error`                        | dropped | —                                                    | Grafana render state, not content.                                                                  |
| `options.code.language`        | tile    | `DashboardMarkdownTileProperties.properties.content` | Code mode content is wrapped in a fenced code block with this language.                             |
| `options.code.showLineNumbers` | dropped | —                                                    | Markdown code blocks have no line numbers.                                                          |
| `options.code.showMiniMap`     | dropped | —                                                    | Markdown code blocks have no minimap.                                                               |
| `options.content`              | tile    | `DashboardMarkdownTileProperties.properties.content` | Copied as the markdown tile content.                                                                |
| `options.mode`                 | tile    | `DashboardMarkdownTileProperties.properties.content` | markdown is copied; html is copied as-is into the markdown; code is wrapped in a fenced code block. |

### `timeseries` options

| Option path                                          | Target               | Lightdash                                                | Note or reason                                                                                                    |
| ---------------------------------------------------- | -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `fieldConfig.defaults.color.fixedColor`              | builtin chart config | `eChartsConfig.series[].color`                           | Resolved to hex with resolveGrafanaColor.                                                                         |
| `fieldConfig.defaults.color.mode`                    | builtin chart config | `eChartsConfig.series[].color`                           | fixed sets each series colour to color.fixedColor; palette and threshold schemes use the project colour palette.  |
| `fieldConfig.defaults.color.seriesBy`                | dropped              | —                                                        | Only matters for Grafana gradient colour schemes, which Lightdash does not have.                                  |
| `fieldConfig.defaults.custom.axisBorderShow`         | dropped              | —                                                        | Lightdash draws its own axis lines; there is no per-axis border switch.                                           |
| `fieldConfig.defaults.custom.axisCenteredZero`       | dropped              | —                                                        | Lightdash axes have no centred-zero mode; min and max are fixed numbers or automatic.                             |
| `fieldConfig.defaults.custom.axisColorMode`          | dropped              | —                                                        | Axis colours follow the Lightdash theme, not the series colour.                                                   |
| `fieldConfig.defaults.custom.axisGridShow`           | builtin chart config | `layout.showGridY`                                       |                                                                                                                   |
| `fieldConfig.defaults.custom.axisLabel`              | builtin chart config | `eChartsConfig.yAxis[].name`                             |                                                                                                                   |
| `fieldConfig.defaults.custom.axisPlacement`          | builtin chart config | `eChartsConfig.series[].yAxisIndex`                      | left is axis 0 and right is axis 1; hidden sets layout.showYAxis to false.                                        |
| `fieldConfig.defaults.custom.axisSoftMax`            | builtin chart config | `eChartsConfig.yAxis[].max`                              | Lightdash max is hard: values above it are clipped, where Grafana would extend the axis.                          |
| `fieldConfig.defaults.custom.axisSoftMin`            | builtin chart config | `eChartsConfig.yAxis[].min`                              | Lightdash min is hard: values below it are clipped, where Grafana would extend the axis.                          |
| `fieldConfig.defaults.custom.barAlignment`           | dropped              | —                                                        | Lightdash centres each bar on its x value.                                                                        |
| `fieldConfig.defaults.custom.barWidthFactor`         | dropped              | —                                                        | Bar width follows the category width; Lightdash has no bar width option.                                          |
| `fieldConfig.defaults.custom.drawStyle`              | builtin chart config | `eChartsConfig.series[].type`                            | line is line, bars is bar and points is scatter.                                                                  |
| `fieldConfig.defaults.custom.fillOpacity`            | builtin chart config | `eChartsConfig.series[].areaStyle`                       | A line series with fillOpacity above 0 becomes an area series; the opacity itself is not kept.                    |
| `fieldConfig.defaults.custom.gradientMode`           | dropped              | —                                                        | Lightdash area and bar fills are flat.                                                                            |
| `fieldConfig.defaults.custom.hideFrom.legend`        | dropped              | —                                                        | Lightdash cannot hide a drawn series from the legend alone.                                                       |
| `fieldConfig.defaults.custom.hideFrom.tooltip`       | dropped              | —                                                        | Lightdash cannot hide a drawn series from the tooltip alone.                                                      |
| `fieldConfig.defaults.custom.hideFrom.viz`           | builtin chart config | `eChartsConfig.series[].hidden`                          |                                                                                                                   |
| `fieldConfig.defaults.custom.insertNulls`            | dropped              | —                                                        | Lightdash does not insert gaps after a time threshold; gaps come from missing rows.                               |
| `fieldConfig.defaults.custom.lineInterpolation`      | builtin chart config | `eChartsConfig.series[].smooth`                          | smooth is true; linear and the step modes are false (Lightdash has no stepped lines).                             |
| `fieldConfig.defaults.custom.lineStyle.fill`         | dropped              | —                                                        | Lightdash series lines are always solid; dashed and dotted lines are not available.                               |
| `fieldConfig.defaults.custom.lineWidth`              | dropped              | —                                                        | Lightdash draws series lines at a fixed width.                                                                    |
| `fieldConfig.defaults.custom.pointSize`              | dropped              | —                                                        | Lightdash draws point symbols at a fixed size.                                                                    |
| `fieldConfig.defaults.custom.scaleDistribution.type` | dropped              | —                                                        | Lightdash value axes are linear; log scales are not available.                                                    |
| `fieldConfig.defaults.custom.showPoints`             | builtin chart config | `eChartsConfig.series[].showSymbol`                      | always is true, never is false, auto keeps the Lightdash default.                                                 |
| `fieldConfig.defaults.custom.showValues`             | builtin chart config | `eChartsConfig.series[].label.show`                      |                                                                                                                   |
| `fieldConfig.defaults.custom.spanNulls`              | builtin chart config | `layout.connectNulls`                                    | true connects across nulls; a time threshold also becomes true.                                                   |
| `fieldConfig.defaults.custom.stacking.group`         | builtin chart config | `eChartsConfig.series[].stack`                           | The group name becomes the stack name.                                                                            |
| `fieldConfig.defaults.custom.stacking.mode`          | builtin chart config | `layout.stack`                                           | normal stacks; percent also stacks, but as absolute values (Lightdash has no 100% stacking); none does not stack. |
| `fieldConfig.defaults.custom.thresholdsStyle.mode`   | builtin chart config | `thresholds.style`                                       | line, dashed, area, line+area and dashed+area keep their names; off drops the thresholds.                         |
| `fieldConfig.defaults.decimals`                      | field format         | `metricQuery.metricOverrides[field].formatOptions.round` | Passed as the decimals of grafanaUnitToCustomFormat.                                                              |
| `fieldConfig.defaults.displayName`                   | builtin chart config | `eChartsConfig.series[].name`                            |                                                                                                                   |
| `fieldConfig.defaults.fieldMinMax`                   | dropped              | —                                                        | Only sets per-field colour scale ranges, which Lightdash does not have.                                           |
| `fieldConfig.defaults.mappings`                      | dropped              | —                                                        | Cartesian charts do not apply value mappings; only tables and the stat entry do.                                  |
| `fieldConfig.defaults.max`                           | builtin chart config | `eChartsConfig.yAxis[].max`                              |                                                                                                                   |
| `fieldConfig.defaults.min`                           | builtin chart config | `eChartsConfig.yAxis[].min`                              |                                                                                                                   |
| `fieldConfig.defaults.noValue`                       | dropped              | —                                                        | Lightdash shows its own empty-result message; there is no custom no-value text.                                   |
| `fieldConfig.defaults.thresholds.mode`               | builtin chart config | `thresholds.mode`                                        |                                                                                                                   |
| `fieldConfig.defaults.thresholds.steps`              | builtin chart config | `thresholds.steps`                                       | Kept only when thresholdsStyle.mode draws them.                                                                   |
| `fieldConfig.defaults.unit`                          | field format         | `metricQuery.metricOverrides[field].formatOptions`       | grafanaUnitToCustomFormat(unit, { decimals }).                                                                    |
| `fieldConfig.defaults.unitScale`                     | dropped              | —                                                        | grafanaUnitToCustomFormat already picks the compact scale for each unit; there is no separate switch.             |
| `fieldConfig.overrides.color`                        | builtin chart config | `eChartsConfig.series[].color`                           | Set on each series the override matches.                                                                          |
| `fieldConfig.overrides.custom.axisPlacement`         | builtin chart config | `eChartsConfig.series[].yAxisIndex`                      | Set on each series the override matches.                                                                          |
| `fieldConfig.overrides.custom.fillOpacity`           | builtin chart config | `eChartsConfig.series[].areaStyle`                       | Set on each series the override matches.                                                                          |
| `fieldConfig.overrides.custom.hideFrom`              | builtin chart config | `eChartsConfig.series[].hidden`                          | Only viz: true is kept; legend and tooltip hiding are dropped.                                                    |
| `fieldConfig.overrides.custom.lineStyle`             | dropped              | —                                                        | Lightdash series lines are always solid; dashed and dotted lines are not available.                               |
| `fieldConfig.overrides.displayName`                  | builtin chart config | `eChartsConfig.series[].name`                            | Set on each series the override matches.                                                                          |
| `fieldConfig.overrides.unit`                         | field format         | `metricQuery.metricOverrides[field].formatOptions`       | Set on each field the override matches, with grafanaUnitToCustomFormat.                                           |
| `options.legend.calcs`                               | dropped              | —                                                        | Lightdash legends show series names only, not per-series statistics.                                              |
| `options.legend.displayMode`                         | builtin chart config | `eChartsConfig.legend.show`                              | hidden is false; list and table are true (table shows as a list).                                                 |
| `options.legend.placement`                           | builtin chart config | `eChartsConfig.legend.placement`                         | bottom keeps the default legend position; right is 'outsideRight'.                                                |
| `options.legend.showLegend`                          | builtin chart config | `eChartsConfig.legend.show`                              |                                                                                                                   |
| `options.legend.sortBy`                              | dropped              | —                                                        | Lightdash legend entries follow the series order.                                                                 |
| `options.legend.sortDesc`                            | dropped              | —                                                        | Lightdash legend entries follow the series order.                                                                 |
| `options.legend.width`                               | builtin chart config | `eChartsConfig.legend.width`                             |                                                                                                                   |
| `options.tooltip.hideZeros`                          | dropped              | —                                                        | Lightdash tooltips are not configurable per chart.                                                                |
| `options.tooltip.mode`                               | dropped              | —                                                        | Lightdash tooltips always list every series at the hovered x (Grafana's all mode).                                |
| `options.tooltip.sort`                               | builtin chart config | `eChartsConfig.tooltipSort`                              | asc is value_ascending, desc is value_descending, none is default.                                                |

### Per-type overrides of the `*` options

These panel types map a `*` option differently from a chart panel:

| Grafana type | Option path   | Target  | Lightdash | Note or reason                                                                                                  |
| ------------ | ------------- | ------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `text`       | `description` | dropped | —         | Markdown and heading tiles have no description; only a title and content.                                       |
| `row`        | `collapsed`   | dropped | —         | Lightdash heading tiles do not collapse; the panels in a collapsed row are imported expanded below the heading. |
| `row`        | `description` | dropped | —         | Markdown and heading tiles have no description; only a title and content.                                       |
