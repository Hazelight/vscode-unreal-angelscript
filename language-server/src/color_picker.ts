import * as typedb from './database';
import * as scriptfiles from './as_parser';

import {
    ColorInformation, ColorPresentation,
    Color, Range,
} from 'vscode-languageserver/node';

export function ProvideDocumentColors(asmodule : scriptfiles.ASModule) : ColorInformation[]
{
    let colors = new Array<ColorInformation>();
    for (let annot of asmodule.annotatedFunctionCalls)
    {
        // Colors specified using literals should show those colors
        if (annot.method.methodAnnotation == typedb.DBMethodAnnotation.IsLinearColor)
        {
            let arglist = annot.node_call.children[1];
            let allConstants = true;
            let values : Array<number> = [];

            if (arglist)
            {
                if (arglist.children)
                {
                    for (let child of arglist.children)
                    {
                        if (!child)
                        {
                            allConstants = false;
                            break;
                        }

                        let [isNumber, value] = scriptfiles.GetConstantNumberFromNode(child);
                        if (isNumber)
                        {
                            values.push(value);
                        }
                        else
                        {
                            allConstants = false;
                            break;
                        }
                    }
                }
            }

            for (let i = values.length; i < 3; ++i)
                values.push(0.0);

            if (allConstants)
            {
                colors.push(<ColorInformation> {
                    color: <Color> {
                        red: values[0],
                        green: values[1],
                        blue: values[2],
                        alpha: values.length > 3 ? values[3] : 1.0,
                    },
                    range: asmodule.getRange(
                        annot.statement.start_offset + annot.node_call.start,
                        annot.statement.start_offset + annot.node_call.end
                    ),
                });
            }
        }
        else if (annot.method.methodAnnotation == typedb.DBMethodAnnotation.IsHexColor)
        {
            let numberValue = 0xff000000;
            let arglist = annot.node_call.children[1];
            if (arglist && arglist.children && arglist.children.length == 1)
            {
                let [isNumber, nodeNumber] = scriptfiles.GetConstantNumberFromNode(arglist.children[0]);
                if (isNumber)
                    numberValue = nodeNumber;
            }

            let range : Range;
            if (arglist)
            {
                range = asmodule.getRange(
                    annot.statement.start_offset + arglist.start,
                    annot.statement.start_offset + arglist.end,
                );
            }
            else
            {
                range = asmodule.getRange(
                    annot.statement.start_offset + annot.node_call.end - 1,
                    annot.statement.start_offset + annot.node_call.end,
                );
            }

            colors.push(<ColorInformation> {
                color: <Color> {
                    red: ((numberValue & 0x00ff0000) >>> 16) / 255.0,
                    green: ((numberValue & 0x0000ff00) >>> 8) / 255.0,
                    blue: (numberValue & 0x000000ff) / 255.0,
                    alpha: ((numberValue & 0xff000000) >>> 24) / 255.0,
                },
                range: range,
            });
        }
    }

    return colors;
}

export function ProvideColorPresentations(asmodule : scriptfiles.ASModule, range : Range, color: Color) : ColorPresentation[]
{
    let colors = new Array<ColorPresentation>();
    let start_offset = asmodule.getOffset(range.start);
    let end_offset = asmodule.getOffset(range.end);

    for (let annot of asmodule.annotatedFunctionCalls)
    {
        if (annot.method.methodAnnotation == typedb.DBMethodAnnotation.IsLinearColor)
        {
            let annot_start = annot.statement.start_offset + annot.node_call.start;
            if (annot_start < start_offset)
                continue;

            let annot_end = annot.statement.start_offset + annot.node_call.end;
            if (annot_end > end_offset)
                continue;

            let argString = `${color.red.toFixed(2)}, ${color.green.toFixed(2)}, ${color.blue.toFixed(2)}`;
            if (color.alpha != 1.0)
                argString += `, ${color.alpha.toFixed(2)}`;

            colors.push(<ColorPresentation> {
                label: `FLinearColor(${argString})`
            });
        }
        else if (annot.method.methodAnnotation == typedb.DBMethodAnnotation.IsHexColor)
        {
            if (annot.node_call.children && annot.node_call.children[1])
            {
                let annot_start = annot.statement.start_offset + annot.node_call.children[1].start;
                if (annot_start < start_offset)
                    continue;

                let annot_end = annot.statement.start_offset + annot.node_call.children[1].end;
                if (annot_end > end_offset)
                    continue;
            }
            else
            {
                let annot_start = annot.statement.start_offset + annot.node_call.end - 1;
                if (annot_start < start_offset)
                    continue;

                let annot_end = annot.statement.start_offset + annot.node_call.end;
                if (annot_end > end_offset)
                    continue;
            }

            let argString = "0x";
            argString += Math.round(color.alpha * 255.0).toString(16).padStart(2, "0");
            argString += Math.round(color.red * 255.0).toString(16).padStart(2, "0");
            argString += Math.round(color.green * 255.0).toString(16).padStart(2, "0");
            argString += Math.round(color.blue * 255.0).toString(16).padStart(2, "0");

            if (end_offset == annot.statement.start_offset + annot.node_call.end)
                argString += ")";

            colors.push(<ColorPresentation> {
                label: argString,
            });
        }
    }

    return colors;
}