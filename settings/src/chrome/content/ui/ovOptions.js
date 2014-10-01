/*  Copyright 2013, 2014 Peter Kehl
 
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";

/* This has many workarounds because of inflexibility in Mozilla XUL model. It can run in two main modes: editable (showing all sets for any modules, or for matching modules) and review (per-folder).
 * On change of fields, it doesn't reload the page, but it only updates elements as needed. However, if you add/remove a configuration set, then it reloads the whole page, which loses the collapse/expand status.
 * */
var XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
var nsIFilePicker = Components.interfaces.nsIFilePicker;
Components.utils.import("resource://gre/modules/FileUtils.jsm" );
Components.utils.import( "chrome://selite-misc/content/SeLiteMisc.js" );
Components.utils.import("resource://gre/modules/osfile.jsm");
//var console = (Components.utils.import("resource://gre/modules/devtools/Console.jsm", {})).console;

var promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
                              .getService(Components.interfaces.nsIPromptService);
Components.utils.import("chrome://selite-settings/content/SeLiteSettings.js" );
Components.utils.import("resource://gre/modules/Services.jsm");
var subScriptLoader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"].getService(Components.interfaces.mozIJSSubScriptLoader);
var nsIIOService= Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService);    
var nsIPrefBranch= Components.interfaces.nsIPrefBranch;

var CREATE_NEW_SET= "Create a new set";
var DELETE_THE_SET= "Delete the set";
var ADD_NEW_VALUE= "Add a new value";
var DELETE_THE_VALUE= "Delete the value";

/** Select a file/folder for a field or a folder for which to load the configuration (via manifests).
 *  @param field Instance of a subclass of Field.FileOrFolder (Field.File, Field.Folder or Field.SQLite), or null if no field
 *  @param tree, used only when changing a field.
 *  @param row int 0-based row index, within the set of *visible* rows only (it skips the collapsed rows)
        var column= { value: null }; // value is instance of TreeColumn.
    @param column instance of TreeColumn
    @param bool isFolder whether it's for a folder, rather than a file
    @param string currentTargetFolder Used as the default folder, when field==null. Optional.
    @param boolean saveFile Whether we're saving/creating a file, otherwise we're opening/reading. Optional, false by default.
    Only needed when isFolder is false, because the file/folder picker dialog always lets you create new folder (if you have access).
    @return false if nothing selected, string file/folder path if selected
 * */
function chooseFileOrFolder( field, tree, row, column, isFolder, currentTargetFolder, saveFile ) {
    var filePicker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
    filePicker.init(
        window,
        "Select a "
        +( isFolder
                ? "folder"
                : "file"
        )
        +( field
                ? " for " +field.name
                : ""
        ),
        isFolder
            ? nsIFilePicker.modeGetFolder
            : (saveFile
                ? nsIFilePicker.modeSave
                : nsIFilePicker.modeOpen
            )
    );
    if( field ) {
        for( var filterName in field.filters ) {
            if( field && field.filters[filterName] ) {
                filePicker.appendFilter( filterName, field.filters[filterName]);
            }
            else { // field==false means that it should be a non-restrictive filter
                filePicker.appendFilters( nsIFilePicker.filterAll);
            }
        }
        var previousValue= tree.view.getCellText(row, column);
        var filePickerDirectoryIsSet= false;
        if( previousValue ) {
            var file= null;
            try {
                file= new FileUtils.File(previousValue);
            }
            catch(e) {}
            if( file!==null && file.exists() ) {
                filePicker.defaultString= file.leafName;
            }
            if( file!==null && file.parent!==null && file.parent.exists() ) {
                var localParent= Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsILocalFile);
                localParent.initWithPath( file.parent.path );
                filePicker.displayDirectory= localParent;
                filePickerDirectoryIsSet= true;
            }
        }
        if( !filePickerDirectoryIsSet ) {
            // Based on https://developer.mozilla.org/en-US/Add-ons/Code_snippets/File_I_O
            var profileDir= Components.classes["@mozilla.org/file/directory_service;1"].getService( Components.interfaces.nsIProperties)
                .get("Home", Components.interfaces.nsIFile);
            filePicker.displayDirectory= profileDir;
        }
    }
    else
    if( currentTargetFolder ) {
        filePicker.displayDirectory= currentTargetFolder;
    }
    var result= filePicker.show();
    if (result===nsIFilePicker.returnOK || result===nsIFilePicker.returnReplace) {
        if( field ) {
            tree.view.setCellText(row, column, filePicker.file.path );
        }
        return filePicker.file.path;
    }
    return false;
}

/** Enumeration-like class. Instances of subclasses indicate hierarchical levels of rows within the tree, or the column.
 * @param {string} name
 * @param {int} level 0-based level/index
 */
function RowLevelOrColumn( name, level ) {
    this.level= level;
    this.name= name;
    if( !('instances' in this.constructor) ) {
        this.constructor.instances= [];
    }
    this.constructor.instances.push( this );
}
RowLevelOrColumn.prototype.toString= function toString() {
    return this.constructor.name+ '.' +this.name;
};
/** This is a simple translation map. It returns n-th argument (counting from 0), where n=this.level.
 * */
RowLevelOrColumn.prototype.forLevel= function forLevel(first, second, etc ) {
    this.level<arguments.length || SeLiteMisc.fail( ''+this+ '.forLevel() was called with few arguments: only ' +arguments.length+ ' of them.' );
    this.constructor.instances.length===arguments.length || SeLiteMisc.fail( "Class " +this.constructor.name+ " has " +this.constructor.instances.length+ " instances, but forLevel() received a different number of arguments: " +arguments.length );
    return arguments[this.level];
};

function RowLevel( name, level ) {
    RowLevelOrColumn.call( this, name, level );
}
RowLevel= SeLiteMisc.proxyEnsureFieldsExist( RowLevel );
RowLevel.prototype= new RowLevelOrColumn();
RowLevel.prototype.constructor= RowLevel;
RowLevel.MODULE= new RowLevel('MODULE', 0);
RowLevel.SET= new RowLevel('SET', 1);
RowLevel.FIELD= new RowLevel('FIELD', 2);
RowLevel.OPTION= new RowLevel('OPTION', 3);

function Column( name, level ) {
    RowLevelOrColumn.call( this, name, level );
}
Column= SeLiteMisc.proxyEnsureFieldsExist( Column );
Column.prototype= new RowLevelOrColumn();
Column.prototype.constructor= Column;
Column.MODULE_SET_FIELD= new Column('MODULE_SET_FIELD', 0);
Column.DEFAULT= new Column('DEFAULT', 1); // @TODO instances after DEFAULT should be treated with -1, if !allowSets
Column.TRUE= new Column('TRUE', 2); // @TODO rename to CHECKED
Column.VALUE= new Column('VALUE', 3);
Column.ACTION= new Column('ACTION', 4);
Column.NULL_UNDEFINE= new Column('NULL_UNDEFINE', 5);

/** It contains elements for <treecol> tags, as returned by document.createElementNS( XUL_NS, 'tree_col').
 These are not nsITreeColumn instances, but their .element fields!
 In order to get nsITreeColumn instance, use treeColumn(). See also comments near a call to getCellAt().
 */
var treeColumnElements= {
    moduleSetField: null,
    defaultSet: null,
    checked: null,
    value: null,
    action: null, // This is 'Set' in folder-based view
    manifest: null
};

/** @param element Element for <treecol> tag, one of those stored in treeColumnElements (as applicable).
 *  @return object Instance of nsITreeColumn, where returnedObject.element=element.
 * */
function treeColumn( element ) {
    var tree= document.getElementById('settingsTree');
    for( var i=0; i<tree.columns.length; i++ ) {
        var column= tree.columns[i];
        if( column.element===element ) {
            return column;
        }
    }
    return null;
}

/** @param allowModules bool Whether we show any module/s rather than just a specific one. If allowModules is true,
 *  there may be none, one or more modules to show.
 *  @param perFolder bool Whether we're showing fields in per-folder mode - then we show a 'Reset' or 'Inherit' buttons and tooltips that
 *  indicate where each field is inherited from.
 * @return node object for <treecols>
 * */
function generateTreeColumns( allowModules, perFolder ) {
    if( typeof allowModules!=='boolean' || typeof allowSets!=='boolean' || typeof allowMultivaluedNonChoices!=='boolean' ) {
        throw new Error('generateTreeColumns() requires all three parameters to be boolean.');
    }
    
    var treecols= document.createElementNS( XUL_NS, 'treecols' );

    var treecol= treeColumnElements.moduleSetField= document.createElementNS( XUL_NS, 'treecol');
    treecol.setAttribute('label',
        allowModules
        ? (allowSets
            ? 'Module/Set/Field'
            : 'Module/Field'
          )
        : (allowSets
            ? 'Set/Field'
            : 'Field'
          )
    );
    treecol.setAttribute( 'flex', '2');
    treecol.setAttribute('primary', 'true'); // without this we don't get expand/collapse triangles
    treecol.setAttribute( 'ordinal', '1');
    treecols.appendChild(treecol);
    
    var splitter= document.createElementNS( XUL_NS, 'splitter' );
    splitter.setAttribute( 'ordinal', '2');
    treecols.appendChild( splitter );
    
    if( allowSets ) {
        treecol= treeColumnElements.defaultSet= document.createElementNS( XUL_NS, 'treecol');
        treecol.setAttribute('label', 'Default');
        treecol.setAttribute('type', 'checkbox');
        treecol.setAttribute('editable', 'true' );
        treecol.setAttribute( 'ordinal', '3');
        treecol.setAttribute( 'tooltip', 'tooltipDefault');
        treecols.appendChild(treecol);
        
        splitter= document.createElementNS( XUL_NS, 'splitter' );
        splitter.setAttribute( 'ordinal', '4');
        treecols.appendChild( splitter );
    }
    
    treecol= treeColumnElements.checked= document.createElementNS( XUL_NS, 'treecol');
    treecol.setAttribute('label', 'True');
    treecol.setAttribute('type', 'checkbox');
    treecol.setAttribute('editable', ''+!perFolder );
    treecol.setAttribute( 'ordinal', '5');
    if( !perFolder ) {
        treecol.setAttribute( 'tooltip', 'tooltipChoice' );
    }
    treecols.appendChild(treecol);

    splitter= document.createElementNS( XUL_NS, 'splitter' );
    splitter.setAttribute( 'ordinal', '6');
    treecols.appendChild( splitter );
    
    treecol= treeColumnElements.value= document.createElementNS( XUL_NS, 'treecol');
    treecol.setAttribute('label', 'Value');
    treecol.setAttribute('editable', ''+!perFolder );
    treecol.setAttribute( 'flex', '1');
    treecol.setAttribute( 'ordinal', '7');
    if( !perFolder ) {
        treecol.setAttribute( 'tooltip', 'tooltipValue');
    }
    treecols.appendChild(treecol);
    
    if( perFolder || allowSets || allowMultivaluedNonChoices ) {
        splitter= document.createElementNS( XUL_NS, 'splitter' );
        splitter.setAttribute( 'ordinal', '8');
        treecols.appendChild( splitter );

        treecol= treeColumnElements.action= document.createElementNS( XUL_NS, 'treecol');
        treecol.setAttribute('label', perFolder
            ? 'Set'
            : 'Action');
        treecol.setAttribute('editable', 'false');
        treecol.setAttribute( 'flex', '1');
        treecol.setAttribute( 'ordinal', '9');
        treecols.appendChild(treecol);
    }
    
    // Per-folder view: Manifest or definition. Per-module view: Null/Undefine
    splitter= document.createElementNS( XUL_NS, 'splitter' );
    splitter.setAttribute( 'ordinal', '10');
    treecols.appendChild( splitter );

    treecol= treeColumnElements.manifest= document.createElementNS( XUL_NS, 'treecol');
    treecol.setAttribute('label', perFolder
        ? 'Manifest or definition'
        : 'Null/Undefine');
    treecol.setAttribute('editable', 'false');
    treecol.setAttribute( 'flex', '1');
    treecol.setAttribute( 'ordinal', '11');
    treecol.setAttribute( 'tooltip', perFolder
        ? 'tooltipManifest'
        : 'tooltipNull'
    );
    treecols.appendChild(treecol);
    return treecols;
}

/** Sorted anonymous object serving as an associative array {
 *     string module name => Module object
 *  }
 * */
var modules= SeLiteMisc.sortedObject(true);

/** Sorted object (anonymous in any other respect) serving as multi-level associative array {
    *   string module name => anonymous object {
    *      string set name (it may be an empty string) => sorted object {
    *          one or none: SET_SELECTION_ROW => <treerow> element/object for the row that has a set selection cell
    *             - only if we show set sellection column and the module allows set selection
    *          zero or more: string field name (field is non-choice and single value) => <treerow> element/object for the row that has that field
    *          zero or more: string field name (the field is multivalue or a choice) => anonymous or sorted object {
    *             value fields (ones with keys that are not reserved) are sorted by key, but entries with reserved keys may be at any position
    *             - one: FIELD_MAIN_ROW => <treerow> element/object for the collapsible row that contains all options for that field
    *             - one: FIELD_TREECHILDREN => <treechildren> element/object for this field, that contains <treeitem><treerow> levels for each option
    *             - zero or more: string key => <treerow> element/object for the row that contains a value/option
    *             - zero or one: NEW_VALUE_ROW => <treerow> element/object for the row that contains a value that the user will only have to fill in
    *               (that is, a row dynamically created but with no value specified yet).
    *          }
           }
           ...
    *   }
    *   ...
 *  }
 * I use this when saving a set/module/all displayed modules.
 *  * */
var treeRowsOrChildren= SeLiteMisc.sortedObject(true);

/** Get a <treecell> element/object from a given treeRow and level
 *  @param object treeRow object/element for <treerow>
 *  @param {Column} level It indicates which column to return <treecell> for
 *  @return object Element for <treecell>
 * */
function treeCell( treeRow, level ) {
    treeRow instanceof XULElement || SeLiteMisc.fail( 'treeCell() requires treeRow to be an XULElement object, but it received ' +treeRow );
    treeRow.tagName==='treerow' || SeLiteMisc.fail( 'treeCell() requires treeRow to be an XULElement object for <treerow>, but it received XULElement for ' +treeRow.tagName );
    level instanceof Column || SeLiteMisc.fail( 'treeCell() requires level to be an instance of Column.' );
    var cells= treeRow.getElementsByTagName( 'treecell' );
    allowSets || level!==Column.DEFAULT || SeLiteMisc.fail( 'allowSets is false, therefore level should not be Column.DEFAULT.' );
    return cells[ allowSets
        ? level.forLevel(0,         1, 2, 3, 4, 5)
        : level.forLevel(0, undefined, 1, 2, 3, 4)
    ];
}

/** Access sub(sub...)container of given parent.
 *  If parent[field1][field2][...] is not defined, then this creates any missing chains as new anonymous naturally sorted objects.
 *  @param parent A parent container
 *  @param string field
 *  @param string another field (optional)
 *  @param string another field (optional)
 *  ....
 *  @return the target parent[field][field2][...]@TODO move to SeLite Misc?
 * */
function subContainer( parent, fieldOrFields ) {
    var object= parent;
    for( var i=1; i<arguments.length; i++ ) {
        var fieldName= arguments[i];
        if( object[fieldName]===undefined ) {
            object[fieldName]= SeLiteMisc.sortedObject(true);
        }
        object= object[fieldName];
    }
    return object;
}

/** Simple shortcut function
 * */
function valueCompound( field, setName ) {
    return moduleSetFields[field.module.name][setName][field.name];
}

/** Generate text for label for 'Null/Undefine' column. Use only in editable mode, which shows set(s) - not for per-folder mode.
 *  @param field Instance of SeLiteSettings.Field
 *  @param valueCompoundEntry Value compound 's .entry for this field, containing its configured value. One of entries from a result of Module.Module.getFieldsOfSet().
 *  @param {boolean} [atOptionLevel] Whether this is called for RowLevel.OPTION level and for SeLiteSettings.Field.FixedMap. Optional; only used if field instanceof SeLiteSettings.Field.FixedMap.
 *  @param {*} [value] Value being shown, or undefined or null. Optional; only used if field is an SeLiteSettings.Field.FixedMap and atOptionLevel is true.
 *  @return string Empty string, 'Null' or 'Undefine', as an appropriate action for this field with the given value.
 * */
function nullOrUndefineLabel( field, valueCompoundEntry, atOptionLevel, value ) {
    !showingPerFolder() || SeLiteMisc.fail( "Don't call nullOrUndefineLabel() when showing fields per folder." );
    !atOptionLevel || field instanceof SeLiteSettings.Field.Choice || field instanceof SeLiteSettings.Field.FixedMap || SeLiteMisc.fail( "atOptionLevel can be true only if the field is an instance of Choice or FixedMap, but it is " +field );
    if( atOptionLevel && field instanceof SeLiteSettings.Field.FixedMap ) { // FixedMap is always multivalued, hence it doesn't allow null
        return value!==undefined
            ? 'Undefine'
            : '';
    }
    else if( !field.multivalued ) {
        return valueCompoundEntry!==undefined
            ? 'Undefine'
            : (valueCompoundEntry!==null && field.allowNull
                ? 'Null'
                : ''
              );
    }
    else {
        // We allow 'Undefine' button only once there are no value(s) for the multivalued field
        return valueCompoundEntry!==undefined && Object.keys(valueCompoundEntry).length===0
            ? 'Undefine'
            : '';
    }
}

function keyFromValueOrPair( valueOrPair ) {
    var key= null; // If valueOrPair is an object with exactly one (iterable) key, this is the key
    if( typeof valueOrPair==='object' && valueOrPair!==null ) {
        var keys= Object.keys(valueOrPair);
        keys.length===1 || SeLiteMisc.fail( "keyFromValueOrPair(): parameter valueOrPair can be an object, but with exactly one field, yet it received one with " +keys.length+ ' fields.' );
        key= keys[0];
    }
    return key;
}

function valueFromValueOrPairAndKey( valueOrPair, key ) {//@TODO eliminate: currently used 1x
    return key!==null
        ? valueOrPair[key]
        : valueOrPair;
}

function collectValueForThisRow( field, value, rowLevel, valueCompound ) {
    SeLiteMisc.ensureInstance( rowLevel, RowLevel );
    if( rowLevel===RowLevel.FIELD && value!==valueCompound.entry) { debugger;}
    return rowLevel===RowLevel.FIELD
        ? valueCompound.entry
        : ( rowLevel===RowLevel.OPTION && field instanceof SeLiteSettings.Field.FixedMap
            ? value
            : undefined
          );
}

/** {Column} column
 *  {SeLiteSettings.Module} module We need this in addition to field when we call it with rowLevel===RowLevel.MODULE (since there is no field at that level).
 *  {string} setName
 *  {SeLiteSettings.Field} field
 *  {string} key
 *  {string} value
 *  {RowLevel} rowLevel
 *  {bool} isNewValueRow
 *  {object} valueCompound
 * */
function generateCellLabel( column, module, setName, field, key, value, rowLevel, isNewValueRow, valueCompound ) {
    SeLiteMisc.ensureInstance( rowLevel, RowLevel );
    SeLiteMisc.ensureInstance( column, Column );
    !field || SeLiteMisc.ensureInstance( field, SeLiteSettings.Field );
    
    if( column===Column.MODULE_SET_FIELD ) {
        return rowLevel.forLevel(
            module
                ? module.name
                : '',
            setName,
            field
                ? field.name
                : '',
            field instanceof SeLiteSettings.Field.FixedMap
                ? key
                : ''
        );
    }
    else if( column===Column.VALUE ) {
        if( rowLevel===RowLevel.MODULE || rowLevel===RowLevel.SET ) {
            return '';
        }
        var valueForThisRow= collectValueForThisRow( field, value, rowLevel, valueCompound );
        (typeof value==='string' || typeof value==='number' || valueForThisRow===null || valueForThisRow===undefined) && !isNewValueRow || SeLiteMisc.fail();
        return value!==null
            ? ''+value
            : ( valueForThisRow===null
                ? 'null'
                : 'undefined'
            );
    }
    else if( column===Column.ACTION ) {
        allowSets || allowMultivaluedNonChoices || showingPerFolder() || SeLiteMisc.fail();
        if( rowLevel===RowLevel.MODULE || rowLevel===RowLevel.SET ) {
            return !setName
                    ? (allowSets && module.allowSets
                        ? CREATE_NEW_SET
                        : ''
                      )
                    : DELETE_THE_SET;
        }
        else if( !showingPerFolder() ) {
            if( field!==null && !SeLiteMisc.isInstance( field, [SeLiteSettings.Field.Choice, SeLiteSettings.Field.FixedMap] )
            && field.multivalued ) {
                if( rowLevel===RowLevel.FIELD ) {
                    return ADD_NEW_VALUE;
                }
                if( rowLevel===RowLevel.OPTION ) {
                    return DELETE_THE_VALUE;
                }
            }
        }
        else if( rowLevel===RowLevel.FIELD ) {
            return valueCompound.fromPreferences
                ? valueCompound.setName
                : (valueCompound.folderPath
                        ? ''
                        : 'module default'
                  );
        }
    }
    else if( column===Column.NULL_UNDEFINE ) {
        rowLevel===RowLevel.FIELD || !showingPerFolder() && rowLevel===RowLevel.OPTION && field instanceof SeLiteSettings.Field.FixedMap || SeLiteMisc.fail();
            // If per-folder view: show Manifest or definition. Otherwise (i.e. per-module view): show Null/Undefine.
        if( !showingPerFolder() ) {
            return nullOrUndefineLabel( field, valueCompound.entry, rowLevel===RowLevel.OPTION, value );
        }
        else {
            return valueCompound.folderPath
                ? OS.Path.join( valueCompound.folderPath, valueCompound.fromPreferences
                        ? SeLiteSettings.ASSOCIATIONS_MANIFEST_FILENAME
                        : SeLiteSettings.VALUES_MANIFEST_FILENAME
                  )
                : (!valueCompound.fromPreferences
                        ? module.definitionJavascriptFile
                        : ''
                  );
        }
    }
    return '';
}

/** @param module object of Module
 *  @param setName string set name; either '' if the module doesn't allow sets; otherwise it's a set name when at field level
 *  attribute for the <treerow> nodes, so that when we handle a click event, we know what field the node is for.
 *  @param field mixed, usually an object of a subclass of Field. If rowLevel==RowLevel.MODULE or rowLevel==RowLevel.SET,
 *  then field is null. Otherwise it must be an instance of a subclass of Field.
 *  @param string key 'key' (used as a trailing part of field option preference name);
 *  use for fields of Field.Choice family and for multivalued fields only. For multivalued non-choice fields it should be the same
 *  as parameter value. If the field is of a subclass of Field.Choice, then key and value may be different.
 *  @param valueOrPair It indicates the value to display.
 *  For single valued non-choice fields or fields not defined in module.fields[]
 *  it is the value/label of the field as shown. Ignored if  not applicable.
 *  For multivalued or choice fields it's an anonymous object serving as an array
 *  { string key => string/number ('primitive') valueItself
 *    ....
 *  } where
 *  - key serves as a trailing part of field option preference name)
 *  -- for multivalued non-choice fields it should be the same as valueItself
 *  -- if the field is of a subclass of Field.Choice, then key and valueItself may be different.
 *  - valueItself is the actual value/label as displayed
 *  @param {RowLevel} rowLevel
 *  @param optionIsSelected bool Whether the option is selected. Only used when rowLevel===RowLevel.OPTION and field instanceof Field.Choice.
 *  @param {bool} [isNewValueRow] Whether the row is for a new value that will be entered by the user. If so, then this doesn't set the label for the value cell.
 *  It still puts the new <treerow> element to treeRowsOrChildren[moduleName...], so that it can be updated/removed once the user fills in the value. Optional; false by default.
 *  @param {object} valueCompound Value compound for this field stored in the set being displayed (or in the sets and manifests applicable to targetFolder, if targetFolder!=null). Its entry part may be different to (the part of) valueOrPair when rowLevel===RowLevel.OPTION, since valueOrPair then indicates what to display for this row. valueCompound is an anonymous object, one of entries in result of Module.getFieldsDownToFolder(..) or Module.Module.getFieldsOfSet(), i.e. in form {
 *          fromPreferences: boolean, whether the value comes from preferences; otherwise it comes from a values manifest or from field default,
 *          setName: string set name (only valid if fromPreferences is true),
 *          folderPath: string folder path to the manifest file (either values manifest, or associations manifest);
 *              empty string '' if the value(s) come from the default set;
 *              null if fromPreferences===true or if the value comes from field default (as in the module definition)
 *          entry: as described for Module.getFieldsDownToFolder(..)
 *  }
 *  Required if rowLevel===RowLevel.FIELD.
 *  @return object for a new element <treeitem> with one <treerow>
 * */
function generateTreeItem( module, setName, field, valueOrPair, rowLevel, optionIsSelected, isNewValueRow, valueCompound ) {
    rowLevel instanceof RowLevel || SeLiteMisc.fail( "Parameter rowLevel must be an instance of RowLevel, but it is " +rowLevel );
    var multivaluedOrChoice= field!==null && (field.multivalued || field instanceof SeLiteSettings.Field.Choice);
    if( typeof valueOrPair==='object' && valueOrPair!==null ) {
        rowLevel===RowLevel.OPTION || SeLiteMisc.fail( "generateTreeItem(): parameter valueOrPair must not be an object, unless rowLevel is OPTION, but rowLevel is " +rowLevel );
        multivaluedOrChoice || SeLiteMisc.fail( 'generateTreeItem(): parameter valueOrPair can be an object only for multivalued fields or choice fields, but it was used with ' +field );
    }
    var key= keyFromValueOrPair( valueOrPair );
    var value= valueFromValueOrPairAndKey( valueOrPair, key );
    
    if( field && typeof field!=='string' && !(field instanceof SeLiteSettings.Field) ) {
        throw new Error( "Parameter field must be an instance of a subclass of Field, unless rowLevel===RowLevel.MODULE or rowLevel===RowLevel.SET, but it is "
            +(typeof field==='object' ? 'an instance of ' +field.constructor.name : typeof field)+ ': ' +field ); //@TODO re/use/move SeLiteMisc
    }
    optionIsSelected= optionIsSelected || false;
    isNewValueRow= isNewValueRow || false;
    valueCompound= valueCompound || null;
    var treeitem= document.createElementNS( XUL_NS, 'treeitem');
    var treerow= document.createElementNS( XUL_NS, 'treerow');
    treeitem.appendChild( treerow );
    // Shortcut xxxName variables prevent null exceptions, so I can pass them as parts of expressions to rowLevel.forLevel(..) without extra validation
    var moduleName= module
        ? module.name
        : '';
    var fieldName= field
        ?   (field instanceof SeLiteSettings.Field
                ? field.name
                : field
            )
        : '';
    /* I use spaces as separators in the following (that's why I don't allow spaces in module/set/field name). For level===RowLevel.OPTION, variable 'key' may contain space(s), since it's the last item on the following list. (That's why there can't be any more entries in 'properties' after 'key'):
    */
    treerow.setAttribute( 'properties',
        rowLevel.forLevel(
            moduleName,
            moduleName+' '+setName,
            moduleName+' '+setName+' '+fieldName,
            moduleName+' '+setName+' '+fieldName+
                (field instanceof SeLiteSettings.Field.Choice || field instanceof SeLiteSettings.Field.FixedMap
                    ? ' ' +key
                    : ''
                )
            )
    );
    
    // Cell for name of the Module/Set/Field, and for keys of SeLiteSettings.Field.FixedMap
    var treecell= document.createElementNS( XUL_NS, 'treecell');
    treerow.appendChild( treecell);
    treecell.setAttribute( 'label', generateCellLabel(Column.MODULE_SET_FIELD, module, setName, field, key, value, rowLevel, isNewValueRow, valueCompound) );
    treecell.setAttribute('editable', 'false');

    if( allowSets ) { // Radio-like checkbox for (de)selecting a set
        treecell= document.createElementNS( XUL_NS, 'treecell');
        treerow.appendChild( treecell);
        if( rowLevel===RowLevel.SET && module.allowSets) {
            subContainer( treeRowsOrChildren, module.name, setName )[ SeLiteSettings.SET_SELECTION_ROW ]= treerow;
            treecell.setAttribute('value', ''+( setName===module.defaultSetName() ) );
        }
        else {
            treecell.setAttribute('value', 'false' );
            treecell.setAttribute('editable', 'false' );
        }
        treecell.setAttribute('properties', SeLiteSettings.DEFAULT_SET_NAME ); // so that I can style it in CSS as a radio button
    }
    // Register treerow in treeRowsOrChildren[][...]
    if( rowLevel===RowLevel.FIELD ) {
        if( !multivaluedOrChoice ) {
           subContainer( treeRowsOrChildren, module.name, setName )[ fieldName ]= treerow;
        }
        else {
            subContainer( treeRowsOrChildren, module.name, setName, fieldName )[ SeLiteSettings.FIELD_MAIN_ROW ]= treerow;
        }
    }
    if( rowLevel===RowLevel.OPTION ) {
        subContainer( treeRowsOrChildren, module.name, setName, fieldName )[ key ]= treerow;
    }
    
    // Cell for checkbox (if the field is boolean) or radio-like select (if the field is a choice):
    treecell= document.createElementNS( XUL_NS, 'treecell');
    treerow.appendChild( treecell);
    if( showingPerFolder()
        || rowLevel!==RowLevel.FIELD && rowLevel!==RowLevel.OPTION
        || !(field instanceof SeLiteSettings.Field.Bool || field instanceof SeLiteSettings.Field.Choice)
        || (typeof value==='string' || typeof value==='number')
           && !(field instanceof SeLiteSettings.Field.Choice)
        || rowLevel===RowLevel.FIELD && field instanceof SeLiteSettings.Field.Choice
        || rowLevel===RowLevel.OPTION && optionIsSelected && !field.multivalued
    ) {
        treecell.setAttribute('editable', 'false');
    }
    if( typeof value==='boolean' ) {
        treecell.setAttribute('value', ''+value);
    }
    if( field instanceof SeLiteSettings.Field.Choice ) {
        treecell.setAttribute( 'value', ''+optionIsSelected );
    }
    if( rowLevel===RowLevel.OPTION ) {
        treecell.setAttribute('properties', field.multivalued
            ? SeLiteSettings.OPTION_NOT_UNIQUE_CELL
            : SeLiteSettings.OPTION_UNIQUE_CELL
        );
    }
    
    // Cell for the text value:
    treecell= document.createElementNS( XUL_NS, 'treecell');
    treerow.appendChild( treecell);
    if( showingPerFolder()
        || rowLevel!==RowLevel.FIELD && rowLevel!==RowLevel.OPTION
        || !(field instanceof SeLiteSettings.Field)
        || field instanceof SeLiteSettings.Field.Bool
        || field.multivalued && rowLevel===RowLevel.FIELD
        || field instanceof SeLiteSettings.Field.Choice
    ) {
        treecell.setAttribute('editable' , 'false');
    }
    
    var valueForThisRow= collectValueForThisRow( field, value, rowLevel, valueCompound );
    if( (typeof value==='string' || typeof value==='number' || valueForThisRow===null || valueForThisRow===undefined)
        && !isNewValueRow
    ) {
        treecell.setAttribute( 'label', generateCellLabel(Column.VALUE, module, setName, field, key, value, rowLevel, isNewValueRow, valueCompound) );
        if( showingPerFolder() && valueCompound!==null ) {
            if( valueCompound.fromPreferences ) {
                treecell.setAttribute( 'properties',
                    valueCompound.folderPath!==''
                        ? SeLiteSettings.ASSOCIATED_SET
                        : SeLiteSettings.DEFAULT_SET
                );
            }
            else {
                treecell.setAttribute( 'properties',
                    valueCompound.folderPath!==null
                        ? SeLiteSettings.VALUES_MANIFEST
                        : SeLiteSettings.FIELD_DEFAULT // For visual effect
                );
            }
        }
        if( valueForThisRow===null || valueForThisRow===undefined ) {
            treecell.setAttribute( 'properties', SeLiteSettings.FIELD_NULL_OR_UNDEFINED );
        }
    }
    if( allowSets || allowMultivaluedNonChoices || showingPerFolder() ) {
        // Cell for Action column (in edit mode) or 'Set' column (in per-folder view)
        treecell= document.createElementNS( XUL_NS, 'treecell');
        treerow.appendChild( treecell);
        treecell.setAttribute('editable', 'false');
        treecell.setAttribute( 'label', generateCellLabel( Column.ACTION, module, setName, field, key, value, rowLevel, isNewValueRow, valueCompound) );
        if( showingPerFolder() && rowLevel===RowLevel.FIELD ) {
            if( valueCompound.fromPreferences && valueCompound.setName===module.defaultSetName() ) {
                treecell.setAttribute( 'properties', SeLiteSettings.DEFAULT_SET );
            }
            else
            if( !valueCompound.fromPreferences && valueCompound.folderPath===null ) {
                treecell.setAttribute( 'properties', SeLiteSettings.FIELD_DEFAULT );
            }
        }
        if( rowLevel===RowLevel.FIELD || !showingPerFolder() && rowLevel===RowLevel.OPTION && field instanceof SeLiteSettings.Field.FixedMap ) {
            // If per-folder view: show Manifest or definition. Otherwise (i.e. per-module view): show Null/Undefine.
            treecell= document.createElementNS( XUL_NS, 'treecell');
            treerow.appendChild( treecell);
            treecell.setAttribute('editable', 'false');
            treecell.setAttribute( 'label', generateCellLabel( Column.NULL_UNDEFINE, module, setName, field, key, value, rowLevel, isNewValueRow, valueCompound) );
            if( showingPerFolder() ) {
                treecell.setAttribute( 'properties', valueCompound.folderPath!==null
                    ? (     valueCompound.folderPath!==''
                            ? (valueCompound.fromPreferences
                                    ? SeLiteSettings.ASSOCIATED_SET
                                    : SeLiteSettings.VALUES_MANIFEST
                              ) + ' ' +valueCompound.folderPath
                            : ''
                      )
                    : SeLiteSettings.FIELD_DEFAULT // For the click handler
                );
            }
        }
    }
    return treeitem;
}

/** @param node moduleChildren <treechildren>
 *  @param object module Module
 * */
function generateSets( moduleChildren, module ) {
    try {
        var setNames= !showingPerFolder()
            ? module.setNames()
            : [null];
        if( !allowSets && setNames.length!==1 ) {
            throw new Error( "allowSets should be set false only if a module has the only set." );
        }
        for( var i=0; i<setNames.length; i++ ) {
            var setName= setNames[i];
            // setFields includes all fields from Preferences DB for the module name, even if they are not in the module definition
            
            var setFields= !showingPerFolder()
                ? module.getFieldsOfSet( setName )
                : module.getFieldsDownToFolder( targetFolder, true );
            if( !showingPerFolder() ) {
                moduleSetFields[module.name]= moduleSetFields[module.name] || {};
                moduleSetFields[module.name][ setName ]= setFields;
            }
            var setChildren= null;
            if( allowSets && module.allowSets ) {
                var setItem= generateTreeItem(module, setName, null, null, RowLevel.SET );
                moduleChildren.appendChild( setItem );
                setChildren= createTreeChildren( setItem );
            }
            else {
                setChildren= moduleChildren;
            }
            generateFields( setChildren, module, setName, setFields );
        }
    }
    catch(e) {
        e.message= 'Module ' +module.name+ ': ' +e.message;
        throw e;
    }
}

/** @param setFields Result of SeLiteSettings.Module.getFieldsOfSet() or SeLiteSettings.Module.getFieldsDownToFolder()
 * */
function generateFields( setChildren, module, setName, setFields ) {
    for( var fieldName in setFields ) {
        var compound= setFields[fieldName];
        var field= fieldName in module.fields //@TODO simplify
            ? module.fields[fieldName]
            : fieldName;
        
        var singleValueOrNull= typeof compound.entry!=='object'
            ? compound.entry
            : null;
        var fieldItem= generateTreeItem(module, setName, field, singleValueOrNull, RowLevel.FIELD, false, false, compound );
        setChildren.appendChild( fieldItem );
        
        var isChoice= field instanceof SeLiteSettings.Field.Choice;
        if( field instanceof SeLiteSettings.Field &&
            (field.multivalued || isChoice)
        ) {
            var fieldChildren= createTreeChildren( fieldItem );
            if( field instanceof SeLiteSettings.Field.FixedMap ) {
                for( var i=0; i<field.keySet.length; i++ ) { //@TODO loop for( .. of ..) once NetBeans supports it
                    var key= field.keySet[i];
                    var pair= {};
                    pair[key]= compound.entry!==undefined
                        ? compound.entry[key]
                        : undefined;
                    var optionItem= generateTreeItem(module, setName, field, pair, RowLevel.OPTION,
                        /*optionIsSelected*/false,
                        /*isNewValueRow*/false,
                        compound
                    );
                    fieldChildren.appendChild( optionItem );
                }
            }
            else {
                var pairsToList= isChoice
                    ? field.choicePairs
                    : compound.entry;

                for( var key in pairsToList ) {////@TODO potential IterableArray
                    var pair= {};
                    pair[key]= pairsToList[key];
                    isChoice || compound.entry===undefined || typeof(compound.entry)==='object' || SeLiteMisc.fail( 'field ' +field.name+ ' has value of type ' +typeof compound.entry+ ': ' +compound.entry );
                    var optionItem= generateTreeItem(module, setName, field, pair, RowLevel.OPTION,
                        isChoice && typeof(compound.entry)==='object'
                            && compound.entry!==null && key in compound.entry,
                        false,
                        compound
                    );
                    fieldChildren.appendChild( optionItem );
                }
            }
            treeRowsOrChildren[ module.name ][ setName ][ fieldName ][ SeLiteSettings.FIELD_TREECHILDREN ]= fieldChildren;
        }
    }
}

/** @param string properties <treerow> or <treecell> 'properties' attribute, which contains space-separated module/set/field/choice(option) name
 *  - as applicable. Do not use with cells for set selection cells.
 *  @param {RowLevel} level It indicates which level we want the name for. Not all levels
 *  may apply. For level===RowLevel.OPTION this may return a string with space(s) in it.
 *  @return string name for the given level, or undefined if there's no property (word) at that level.
 *  Side note: I would have used https://developer.mozilla.org/en-US/docs/Web/API/element.dataset,
 *  but I didn't know (and still don't know) how to get it for <treerow> element where the user clicked - tree.view doesn't let me.
 * */
function propertiesPart( properties, level ) {
    level instanceof RowLevel || SeLiteMisc.fail( "propertiesPart() expects parameter level to be an instance of RowLevel, but its type is " +(typeof level)+ ": " +level );
    var propertiesParts= properties.split( ' ' );
    
    if( level.level>=propertiesParts.length ) {
        return undefined;
    }
    if( level!==RowLevel.OPTION ) {
        return propertiesParts[level.level];
    }
    // Column.VALUE stands for anything in properties after the part for previous (COLUMN.MODULE...COLUMN.FIELD). That's because the part of properties that represents field 'value' (@TODO check: is it the value or the key) may contain space(s). That's why this concatenates the slices with spaces.
    propertiesParts= propertiesParts.slice( level.level );
    return propertiesParts.join( ' ');
}

/** 0-based index of row beig currently edited, within the set of *visible* rows only (it skips the collapsed rows),
 *  only if the row is for a new value of a multi-valued field and that value was not saved/submitted yet. Otherwise it's undefined.
 *  @see onTreeBlur()
 *   */
var newValueRow= undefined;
var pastFirstBlur= false;

/** When performing validation of a freetype values, most frequent use cases are handled in setCellText handler.
 *  From Firefox 25, the only relevant scenario not handled by setCellText() is when a user hits 'Add a new value'
 *  for a multi-valued field and then they hit ESC without filling in the value. That's when onTreeBlur() performs the validation.
 *  @see setCellText()
 */
function onTreeBlur() {
    //console.log('onblur; newValueRow: ' +newValueRow+ '; pastFirstBlur: ' +pastFirstBlur);
    if( newValueRow!==undefined ) {
        if( pastFirstBlur ) {
            var info= preProcessEdit( newValueRow, '' ); // This assumes that a new value is only empty. Otherwise we'd have to retrieve the actual value. 
            // If validation fails, I'm not calling startEditing(..). See notes in setCellText()
            pastFirstBlur= false;
            newValueRow= undefined;
        }
        else {
            pastFirstBlur= true;
        }
    }
}

function treeClickHandler( event ) {
    //console.log( 'click');
    // FYI: event.currentTarget.tagName=='tree'. However, document.getElementById('settingsTree')!=event.currentTarget
    var tree= document.getElementById('settingsTree');
    var row= { value: -1 }; // value will be 0-based row index, within the set of *visible* rows only (it skips the collapsed rows)
    var column= { value: null }; // value is instance of TreeColumn. See https://developer.mozilla.org/en-US/docs/XPCOM_Interface_Reference/nsITreeColumn
            // column.value.element is one of 'treecol' nodes created above. column.value.type can be TreeColumn.TYPE_CHECKBOX etc.
    tree.boxObject.getCellAt(event.clientX, event.clientY, row, column, {}/*unused, but needed*/ );
    
    if( row.value>=0 && column.value ) {
        var modifiedPreferences= false;
        var rowProperties= tree.view.getRowProperties(row.value);
        var clickedOptionKey= propertiesPart( rowProperties, RowLevel.OPTION );
        var moduleName= propertiesPart( rowProperties, RowLevel.MODULE );
        var module= modules[moduleName];
        var moduleRowsOrChildren= treeRowsOrChildren[moduleName];
        var field= module.fields[ propertiesPart( rowProperties, RowLevel.FIELD ) ];
        if( column.value!==null && row.value>=0 ) {
            var cellIsEditable= tree.view.isEditable(row.value, column.value);
            var cellValue= tree.view.getCellValue(row.value, column.value); // For checkboxes this is true/false as toggled by the click.
            var cellProperties= tree.view.getCellProperties( row.value, column.value ); // Space-separated properties
            var cellText= tree.view.getCellText(row.value, column.value);
            
            var selectedSetName= propertiesPart( rowProperties, RowLevel.SET );
            if( allowSets && column.value.element===treeColumnElements.defaultSet && cellIsEditable ) { // Make the selected set be default, or unflag it as default.
                module.setDefaultSetName( cellValue==='true'
                    ? selectedSetName
                    : null
                );
                modifiedPreferences= true;
                if( cellValue==='true' ) { // We're making the selected set default, hence de-select previously default set (if any)
                    for( var setName in moduleRowsOrChildren ) {
                        var treeRow= moduleRowsOrChildren[setName][SeLiteSettings.SET_SELECTION_ROW];
                        var cell= treeCell( treeRow, Column.DEFAULT );
                        if( setName!==selectedSetName) {
                            cell.setAttribute( 'value', 'false' );
                        }
                    }
                }
                SeLiteSettings.changedDefaultSet();
            }
            if( column.value.element===treeColumnElements.checked && cellIsEditable ) {
                var isSingleNonChoice= !(field.multivalued || field instanceof SeLiteSettings.Field.Choice);
                
                if( isSingleNonChoice  ) {
                    field instanceof SeLiteSettings.Field.Bool || SeLiteMisc.fail('field ' +field.name+ ' should be Field.Bool');
                    var clickedCell= treeCell( moduleRowsOrChildren[selectedSetName][field.name], Column.TRUE );
                    field.setValue( selectedSetName, clickedCell.getAttribute( 'value')==='true' );
                    // I don't need to call updateSpecial() here - if the field was SeLiteSettings.NULL, then the above setValue() replaced that
                }
                else {
                    var clickedTreeRow= moduleRowsOrChildren[selectedSetName][field.name][ clickedOptionKey ];
                    var clickedCell= treeCell( clickedTreeRow, Column.TRUE );
                    
                    if( !field.multivalued ) { // field is a single-valued choice. The field is only editable if it was unchecked
                        // - so the user checked it now. Uncheck & remove the previously checked value (if any).
                        for( var otherOptionKey in moduleRowsOrChildren[selectedSetName][field.name] ) { // de-select the previously selected value, make it editable
                            
                            if( SeLiteSettings.reservedNames.indexOf(otherOptionKey)<0 && otherOptionKey!==clickedOptionKey ) {
                                var otherOptionRow= moduleRowsOrChildren[selectedSetName][field.name][otherOptionKey];
                                
                                var otherOptionCell= treeCell( otherOptionRow, Column.TRUE );
                                if( otherOptionCell.getAttribute('value')==='true' ) {
                                    otherOptionCell.setAttribute( 'value', 'false');
                                    otherOptionCell.setAttribute( 'editable', 'true');
                                    field.removeValue( selectedSetName, otherOptionKey );
                                }
                            }
                        }
                        clickedCell.setAttribute( 'editable', 'false');
                        field.addValue( selectedSetName, clickedOptionKey );
                    }
                    else {
                        var checkedAfterClick= clickedCell.getAttribute('value')==='true';
                        checkedAfterClick
                            ? field.addValue( selectedSetName, clickedOptionKey )
                            : field.removeValue( selectedSetName, clickedOptionKey );
                    }
                    updateSpecial( selectedSetName, field,
                        !field.multivalued
                            ? 0
                            : (checkedAfterClick
                                ? +1
                                : -1
                            ),
                        clickedOptionKey );
                }
                modifiedPreferences= true;
            }
            if( column.value.element===treeColumnElements.value ) {
                if( cellIsEditable && rowProperties) {
                    if( !showingPerFolder() ) {
                        if( !(field instanceof SeLiteSettings.Field.FileOrFolder) ) {
                            tree.startEditing( row.value, column.value );
                        }
                        else {
                            chooseFileOrFolder( field, tree, row.value, column.value, field.isFolder, undefined, field.saveFile ); // On change that will trigger my custom setCellText()
                        }
                    }
                }
            }
            if( column.value.element===treeColumnElements.action ) {
                if( cellProperties==='' ) {
                    if( cellText===CREATE_NEW_SET ) {
                        var setName= prompt('Enter the new set name');
                        if( setName ) {
                            module.createSet( setName );
                            SeLiteSettings.savePrefFile(); // Must save here, before reload()
                            window.location.reload();//@TODO ?module=...&set=...
                            // @TODO URL param set -> selectedSet
                            // @TODO support ?selectedModule=...&selectedSet=...
                            // and ?module=...& selectedSet=...
                        }
                    }
                    if( cellText===DELETE_THE_SET ) {
                        if( confirm('Are you sure you want to delete this set?') ) {
                            if( selectedSetName===module.defaultSetName() ) {
                                module.setDefaultSetName();
                            }
                            module.removeSet( selectedSetName);
                            SeLiteSettings.savePrefFile(); // Must save here, before reload()
                            window.location.reload();
                        }
                    }
                    if( (cellText===ADD_NEW_VALUE || cellText===DELETE_THE_VALUE) ) {
                        if( !field.multivalued || field instanceof SeLiteSettings.Field.Choice ) {
                            SeLiteMisc.fail( 'We only allow Add/Delete buttons for non-choice multivalued fields, but it was triggered for field ' +field.name );
                        }
                        var treeChildren= moduleRowsOrChildren[selectedSetName][field.name][SeLiteSettings.FIELD_TREECHILDREN];
                        if( cellText===ADD_NEW_VALUE ) {
                            // Add a row for a new value, right below the clicked row (i.e. at the top of all existing values)
                            var pair= {};
                            pair[ SeLiteSettings.NEW_VALUE_ROW ]= SeLiteSettings.NEW_VALUE_ROW;
                            // Since we're editing, it means that showingPerFolder()===false, so I don't need to generate anything for navigation from folder view here.
                            var treeItem= generateTreeItem(module, selectedSetName, field, pair, RowLevel.OPTION, false, /*Don't show the initial value:*/true );

                            var previouslyFirstValueRow;
                            for( var key in moduleRowsOrChildren[selectedSetName][field.name] ) {
                                if( SeLiteSettings.reservedNames.indexOf(key)<0 ) {
                                    previouslyFirstValueRow= moduleRowsOrChildren[selectedSetName][field.name][key];
                                    previouslyFirstValueRow instanceof XULElement && previouslyFirstValueRow.tagName==='treerow' && previouslyFirstValueRow.parentNode.tagName==='treeitem' || SeLiteMisc.fail();
                                    break;
                                }
                            }
                            // Firefox 22.b04 and 24.0a1 doesn't handle parent.insertBefore(newItem, null), even though it should - https://developer.mozilla.org/en-US/docs/Web/API/Node.insertBefore
                            if(true) {//@TODO test in new Firefox, choose one branch
                                if( previouslyFirstValueRow!==undefined ) {
                                    treeChildren.insertBefore( treeItem, previouslyFirstValueRow.parentNode );
                                }
                                else {
                                    treeChildren.appendChild( treeItem );
                                }
                            }
                            else {
                                treeChildren.insertBefore( treeItem,
                                    previouslyFirstValueRow!==undefined
                                        ? previouslyFirstValueRow.parentNode
                                        : null );
                            }
                            if( treeChildren.parentNode.getAttribute('open')!=='true' ) {
                                treeChildren.parentNode.setAttribute('open', 'true');
                            }
                            tree.boxObject.ensureRowIsVisible( row.value+1 );
                            if( field instanceof SeLiteSettings.Field.FileOrFolder ) {
                                chooseFileOrFolder( field, tree, row.value+1, treeColumn(treeColumnElements.value), field.isFolder, undefined, field.saveFile ); // On change that will trigger my custom setCellText()
                            }
                            else {
                                tree.startEditing( row.value+1, treeColumn(treeColumnElements.value) );
                            }
                        }
                        if( cellText===DELETE_THE_VALUE ) {
                            var clickedTreeRow= moduleRowsOrChildren[selectedSetName][field.name][ clickedOptionKey ]; // same as above
                            delete moduleRowsOrChildren[selectedSetName][field.name][ clickedOptionKey ];
                            treeChildren.removeChild( clickedTreeRow.parentNode );
                            field.removeValue( selectedSetName, clickedOptionKey );
                            updateSpecial( selectedSetName, field, -1 );
                            modifiedPreferences= true;
                        }
                    }
                }
                else {
                    window.open( '?module=' +escape(module.name)+ '&set=' +escape(cellText), '_blank');
                }
            }
            if( column.value.element===treeColumnElements.manifest ) { // Manifest, or Null/Undefine
                if( showingPerFolder() ) {
                    if( cellProperties!==SeLiteSettings.FIELD_DEFAULT ) {
                        if( cellProperties.startsWith(SeLiteSettings.ASSOCIATED_SET) ) {
                            var folder= cellProperties.substring( SeLiteSettings.ASSOCIATED_SET.length+1 );
                            window.open( 'file://' +OS.Path.join(folder, SeLiteSettings.ASSOCIATIONS_MANIFEST_FILENAME), '_blank' );
                        }
                        else {
                            SeLiteMisc.ensure( cellProperties.startsWith(SeLiteSettings.VALUES_MANIFEST) );
                            var folder= cellProperties.substring( SeLiteSettings.VALUES_MANIFEST.length+1 );
                            window.open( 'file://' +OS.Path.join(folder, SeLiteSettings.VALUES_MANIFEST_FILENAME), '_blank' );
                        }
                    }
                    else
                    if( cellProperties!=='' ) {
                        window.open( SeLiteSettings.fileNameToUrl(module.definitionJavascriptFile), '_blank' );
                    }
                }
                else {
                    if( cellText==='Null' || cellText==='Undefine' ) {
                        if( clickedOptionKey!==undefined ) {
                            // Our state flow is: value selected -> click 'Null' -> null -> click 'Undefine' -> undefined. So option(s) could be selected only when we click 'Null'; when we click 'Undefine', the field was already set to null (and no option(s) were selected). Therefore this if() branch is simpler than its else {} branch (which handles clicking at 'Null' and unsetting any selected option).
                            field instanceof SeLiteSettings.Field.FixedMap || SeLiteMisc.fail( "Buttons Null/Undefine should show up at this level only for fields that are instances of SeLiteSettings.Field.FixedMap. However, it showed up for " +field );
                            updateSpecial( selectedSetName, field, 0,
                                cellText==='Null'
                                    ? null
                                    : undefined,
                                clickedOptionKey
                            );
                            // Set/unset SeLiteSettings.VALUE_PRESENT on the field, if applicable:
                            updateSpecial( selectedSetName, field,
                                cellText==='Null'
                                    ? 1
                                    : -1 );
                        }
                        else {
                            updateSpecial( selectedSetName, field, 0,
                                cellText==='Null'
                                    ? null
                                    : undefined );
                            var compound= moduleSetFields[moduleName][selectedSetName][field.name];
                            if( field instanceof SeLiteSettings.Field.Bool && compound.entry ) {
                                treeCell( fieldTreeRow(selectedSetName, field), Column.TRUE ).setAttribute( 'value', 'false' );
                            }
                            !field.multivalued || !(field instanceof SeLiteSettings.Field.Choice) || SeLiteMisc.fail('There should be no Null button for multivalued choices.' );
                            if( !field.multivalued && field instanceof SeLiteSettings.Field.Choice && compound.entry ) {
                                var keys= Object.keys(compound.entry);
                                keys.length===1 || SeLiteMisc.fail();
                                var previousChoiceCell= treeCell( treeRowsOrChildren[moduleName][selectedSetName][field.name][ keys[0] ], Column.TRUE );
                                previousChoiceCell.setAttribute( 'value', 'false' );
                                previousChoiceCell.setAttribute( 'editable', 'true' );
                            }
                        }
                        modifiedPreferences= true;
                    }
                }
            }
        }
        if( modifiedPreferences ) {
            SeLiteSettings.savePrefFile();
            
            if( column.value.element!==treeColumnElements.defaultSet ) {
                moduleSetFields[moduleName][selectedSetName]= module.getFieldsOfSet( selectedSetName );
                
                var fieldRow= fieldTreeRow(selectedSetName, field);
                var rowToUpdate;
                !clickedOptionKey || field instanceof SeLiteSettings.Field.Choice || field instanceof SeLiteSettings.Field.FixedMap || SeLiteMisc.fail( "When clickedOptionKey is set, the field should be an instance of Choice or FixedMap.");
                if( clickedOptionKey && field instanceof SeLiteSettings.Field.FixedMap ) { // The user clicked at 'undefine' for an option of a FixedMap instance
                    rowToUpdate= moduleRowsOrChildren[selectedSetName][field.name][ clickedOptionKey ]; // same as clickedTreeRow above
                }
                else {
                    rowToUpdate= fieldRow;
                }
                var valueCell= treeCell( rowToUpdate, Column.TRUE/* TODO?!?! When I tried VALUE, things were not better.*/ );
                valueCell.setAttribute( 'properties',
                    cellText==='Null' || cellText==='Undefine'
                        ? SeLiteSettings.FIELD_NULL_OR_UNDEFINED
                        : ''
                );
                if( cellText==='Null' || cellText==='Undefine' ) {
                    valueCell.setAttribute( 'label',
                        cellText==='Null'
                            ? 'null'
                            : 'undefined' );
                }
                else
                if( column.value.element===treeColumnElements.checked ) { // This clears the previous label 'undefined' or 'null' (if any)
                    valueCell.setAttribute( 'label', '' );
                }
                
                clickedOptionKey===undefined || SeLiteMisc.ensureInstance( field, [SeLiteSettings.Field.Choice, SeLiteSettings.Field.FixedMap] );
                treeCell( rowToUpdate, Column.NULL_UNDEFINE ).setAttribute( 'label',
                    clickedOptionKey===undefined
                    ? nullOrUndefineLabel( field, valueCompound(field, selectedSetName).entry )
                    : nullOrUndefineLabel( field, valueCompound(field, selectedSetName).entry, true,
                        moduleSetFields[moduleName][selectedSetName][field.name].entry[clickedOptionKey]
                      )
                );
                //@TODO
                if( clickedOptionKey ) {
                    // fieldRow: 1. 'undefined' 2. Null/Undefine
                }
            }
        }
    }
}

/** @return <treerow> element for given set and field, that
 *  - for single-valued non-choice field contains the field
 *  - for multi-valued or choice field it is the collapsible/expandable row for the whole field
 * */
function fieldTreeRow( setName, field ) {
    return !field.multivalued && !(field instanceof SeLiteSettings.Field.Choice)
        ? treeRowsOrChildren[field.module.name][setName][field.name]
        : treeRowsOrChildren[field.module.name][setName][field.name][SeLiteSettings.FIELD_MAIN_ROW];
}

/** Gather some information about the cell, the field, set and module. Validate the value, show an alert if validation fails. If there is a valid change of the field, show/hide 'Undefine' or 'Null' label and related 'properties'.
 <br>Only used after type events (setCellText, or blur other than ESC).
 * @param row is 0-based index among the expanded rows, not all rows.
 * @param string value new value (as typed)
 * @return object An anonymous object {
       module: instance of SeLiteSettings.Module,
        rowProperties: string,
        setName: string,
        field: ??,
        treeRow: ??,
        oldKey: mixed, previous value
        - string, the key as it was before this edit (or the fixed key for FixedMap) - for a multi-valued field
        - mixed previous value (including Javascript null/undefined) - for single-valued field
        validationPassed: boolean,
        valueChanged: boolean,
        parsed: mixed, the parsed value, string or number (after trimmed)
        fieldTreeRowsOrChildren: object, retrieved as 2nd level entry from moduleRowsOrChildren;
          serving as an associative array, with values being <treerow> or <treechildren> objects for the field {
            string value or option key => <treerow> object
            ...
            SeLiteSettings.FIELD_MAIN_ROW => <treerow> for the main (collapsible) level of this field
            SeLiteSettings.FIELD_TREECHILDREN => <treechildren>
            SeLiteSettings.NEW_VALUE_ROW => <treerow> for the new value to be added (not saved yet), optional
        }
 *  }
 * */
function preProcessEdit( row, value ) {
    var tree= document.getElementById( 'settingsTree' );
    var rowProperties= tree.view.getRowProperties(row);

    var moduleName= propertiesPart( rowProperties, RowLevel.MODULE );
    var module= modules[moduleName];
    var setName= propertiesPart( rowProperties, RowLevel.SET );
    var fieldName= propertiesPart( rowProperties, RowLevel.FIELD );
    var field= module.fields[fieldName];

    var moduleRowsOrChildren= treeRowsOrChildren[moduleName];
    var fieldTreeRowsOrChildren= null; //Non-null only if field.multivalued==true
    var treeRow;
    var oldKey;
    var validationPassed= true;
    /** @var {boolean}*/ var valueChanged;
    field!==undefined || SeLiteMisc.fail( 'field ' +fieldName+ ' is undefined');
    var trimmed= field.trim(value);
    var parsed;
    if( !field.multivalued ) {
        if( !(field instanceof SeLiteSettings.Field.FixedMap) ) {
            treeRow= moduleRowsOrChildren[setName][fieldName];
            // Can't use treeRow.constructor.name here - because it's a native object.
            treeRow instanceof XULElement && treeRow.tagName==='treerow' || SeLiteMisc.fail( 'treeRow should be an instance of XULElement for a <treerow>.');
            var oldKey= moduleSetFields[moduleName][setName][fieldName].entry;
            valueChanged= value!==''+oldKey;
        }
        else {
            //@TODO cast value to the exact type, then use strict comparison ===
            //@TODO Check what if the whole field (.entry) is undefined. 
            var oldValue= module.getFieldsOfSet( setName )[ field.name ].entry[ oldKey ];
            valueChanged= value!=oldValue;
        }
    }
    else {
        fieldTreeRowsOrChildren= moduleRowsOrChildren[setName][fieldName];
        fieldTreeRowsOrChildren instanceof SeLiteMisc.SortedObjectTarget || SeLiteMisc.fail( "fieldTreeRowsOrChildren should be an instance of SeLiteMisc.SortedObjectTarget, but it is " +fieldTreeRowsOrChildren.constructor.name );
        oldKey= propertiesPart( rowProperties, RowLevel.OPTION );
        oldKey!==null && oldKey!==undefined || SeLiteMisc.fail( 'Module ' +module.name+ ', set ' +setName+ ', field ' +field.name+ " is null/undefined, but it shoduln't be because it's a multi-valued field.");
        valueChanged= value!==oldKey; // oldKey is a string, so this comparison is OK
        if( valueChanged ) {
            if( trimmed in fieldTreeRowsOrChildren ) {
                alert( "Values must be unique. Another entry for field " +field.name+ " already has same (trimmed) value " +trimmed );
                validationPassed= false;
            }
        }
        treeRow= fieldTreeRowsOrChildren[oldKey];
    }
    if( validationPassed && valueChanged ) {
        parsed= field.parse(trimmed);
        validationPassed= field.validateKey(parsed) && (!field.customValidate || field.customValidate.call(null, parsed) );
        if( !validationPassed ) {
            alert('Field ' +field.name+ " can't accept "+ (
                trimmed.length>0
                    ? 'value ' +trimmed
                    : 'whitespace.'
            ) );
        }
    }
    if( validationPassed ) {
        if( valueChanged ) {
            var fieldRow= fieldTreeRow(setName, field);
            treeCell( fieldRow, Column.VALUE/*@TODO?!?!:TRUE (originally FIELD)*/ ).setAttribute( 'properties', '' ); // Clear it, in case it was SeLiteSettings.FIELD_NULL_OR_UNDEFINED (which has special CSS style)
            if( !(field instanceof SeLiteSettings.Field.FixedMap) ) {
                if( field.multivalued ) { //Clear it, in case it was 'undefined' (if this is the first value)
                    treeCell( fieldRow, Column.TRUE/*@TODO VALUE fails?!?!:TRUE (original FIELD)*/ ).setAttribute( 'label', '' );
                }
                /*treeCell( fieldRow, Column.NULL_UNDEFINE ).setAttribute( 'label',
                    generateCellLabel( Column.NULL_UNDEFINE, module, setName, field, undefined, value, RowLevel.FIELD, false, valueCompound ) );*/
                treeCell( fieldRow, Column.NULL_UNDEFINE ).setAttribute( 'label',
                    nullOrUndefineLabel( field, valueCompound(field, setName).entry )
                );/**/
            }
            else {
                var optionRow= treeRowsOrChildren[module.name][setName][field.name][oldKey];
                treeCell( optionRow, Column.VALUE/*@TODO?!?!:TRUE (original FIELD)*/ ).setAttribute( 'properties', '' ); // Clear at option level, in case it was SeLiteSettings.FIELD_NULL_OR_UNDEFINED
                /*treeCell( optionRow, Column.NULL_UNDEFINE ).setAttribute( 'label',
                    generateCellLabel( Column.NULL_UNDEFINE, module, setName, field, undefined, value, RowLevel.OPTION, false, valueCompound ) );*/ //@TODO cast value to the exact type?
                treeCell( optionRow, Column.NULL_UNDEFINE ).setAttribute( 'label',
                    nullOrUndefineLabel( field, valueCompound(field, setName).entry, true, value ) //@TODO cast value to the exact type
                );/**/
            }
        }
    }
    else {
        if( field.multivalued && fieldTreeRowsOrChildren[SeLiteSettings.NEW_VALUE_ROW] ) { // adding first value for a multivalued field
            fieldTreeRowsOrChildren[SeLiteSettings.FIELD_TREECHILDREN].removeChild( fieldTreeRowsOrChildren[SeLiteSettings.NEW_VALUE_ROW].parentNode );
            delete treeRowsOrChildren[module.name][setName][field.name][SeLiteSettings.NEW_VALUE_ROW];
        }
    }
    return {
        module: module,
        rowProperties: rowProperties,
        setName: setName,
        field: field,
        fieldTreeRowsOrChildren: fieldTreeRowsOrChildren,
        treeRow: treeRow,
        oldKey: oldKey,
        validationPassed: validationPassed,
        valueChanged: valueChanged,
        parsed: parsed
    };
}

/** This - nsITreeView.setCellText() - gets triggered only for string/number fields and for File fields; not for checkboxes.
 *  @param row is 0-based index among the expanded rows, not all rows.
 *  @param col I don't use it, because I use module definition to figure out the editable cell.
 *  @param string value new value
 *  @param object original The original TreeView
 * */
function setCellText( row, col, value, original) {
    //console.log('setCellText');
    newValueRow= undefined; // This is called before 'blur' event, so we validate here. We only leave it for onTreeBlur() if setCellText doesn't get called.
    var info= preProcessEdit( row, value );
    if( !info.validationPassed || !info.valueChanged ) {
        // If validation fails, I wanted to keep the field as being edited, but the following line didn't work here in Firefox 25.0. It could also interfere with onTreeBlur().
        //if( !info.validationPassed ) { document.getElementById( 'settingsTree' ).startEditing( row, col ); }
        return; // if validation failed, preProcessEdit() already showed an alert, and removed the tree row if the value was a newly added entry of a multi-valued field
    }
    original.setCellText( row, col, value );
    if( !info.field.multivalued ) {
        info.field.setValue( info.setName, info.parsed );
        // I don't need to call updateSpecial() here - if the field was SeLiteSettings.NULL, then the above setValue() replaced that
    }
    else
    if( !(info.field instanceof SeLiteSettings.Field.FixedMap) ) {
        var rowAfterNewPosition= null; // It may be null - then append the new row at the end; if same as treeRow, then the new value stays in treeRow.
            // If the new value still fits at the original position, then rowAfterNewPosition will be treeRow.
        for( var otherKey in info.fieldTreeRowsOrChildren ) {
            // Following check also excludes SeLiteSettings.NEW_VALUE_ROW, because we don't want to compare it to real values. 
            if( SeLiteSettings.reservedNames.indexOf(otherKey)<0 && info.field.compareValues(otherKey, value)>=0 ) {
                rowAfterNewPosition= info.fieldTreeRowsOrChildren[otherKey];
                break;
            }
        }
        if( rowAfterNewPosition===null && info.fieldTreeRowsOrChildren[SeLiteSettings.NEW_VALUE_ROW] && Object.keys(info.fieldTreeRowsOrChildren).length===3 ) {
            // fieldTreeRowsOrChildren has 3 keys: SeLiteSettings.FIELD_MAIN_ROW, SeLiteSettings.FIELD_TREECHILDREN, SeLiteSettings.NEW_VALUE_ROW.
            // So there's no other existing value, and the row being edited is a new one (it didn't have a real value set yet)
            info.fieldTreeRowsOrChildren[SeLiteSettings.NEW_VALUE_ROW]===info.treeRow && info.oldKey===SeLiteSettings.NEW_VALUE_ROW
            || SeLiteMisc.fail( "This assumes that if fieldTreeRowsOrChildren[SeLiteSettings.NEW_VALUE_ROW] is set, then that's the row we're just editing." );
            rowAfterNewPosition= info.treeRow;
        }
        if( rowAfterNewPosition!==info.treeRow ) { // Repositioning - remove treeRow, create a new treeRow
            var treeChildren= info.fieldTreeRowsOrChildren[SeLiteSettings.FIELD_TREECHILDREN];
            treeChildren.removeChild( info.treeRow.parentNode );
            var pair= {};
            pair[ value ]= value;
            var treeItem= generateTreeItem( info.module, info.setName, info.field, pair, RowLevel.OPTION ); // That sets 'properties' and it adds an entry to treeRow[value]
                // (which is same as fieldTreeRowsOrChildren[value] here).
            // Firefox 22.b04 and 24.0a1 doesn't handle parent.insertBefore(newItem, null), even though it should - https://developer.mozilla.org/en-US/docs/Web/API/Node.insertBefore
            if(true){//@TODO cleanup
                if( rowAfterNewPosition!==null ) {
                    treeChildren.insertBefore( treeItem, rowAfterNewPosition.parentNode );
                }
                else {
                    treeChildren.appendChild( treeItem );
                }
            }
            else {
                treeChildren.insertBefore( treeItem,
                rowAfterNewPosition!==null
                    ? rowAfterNewPosition.parentNode
                    : null );
            }
            treeItem.focus();
        }
        else { // No repositioning - just update 'properties' attribute
            info.fieldTreeRowsOrChildren[value]= info.treeRow;
            var propertiesPrefix= info.rowProperties.substr(0, /*length:*/info.rowProperties.length-info.oldKey.length); // That includes a trailing space
            info.treeRow.setAttribute( 'properties', propertiesPrefix+value );
        }
        delete info.fieldTreeRowsOrChildren[info.oldKey];
        if( info.oldKey!==SeLiteSettings.NEW_VALUE_ROW ) {
            info.field.removeValue( info.setName, info.oldKey );
        }
        else {
            updateSpecial( info.setName, info.field, +1 );
        }
        info.field.addValue( info.setName, info.parsed );
    }
    else {
        updateSpecial( info.setName, info.field, +1 ); // unset SeLiteSettings.VALUE_PRESENT on the field, if applicable
        var setNameDot= info.setName!==''
            ? info.setName+'.'
            : '';
        info.field.setPref( setNameDot+ info.field.name+ '.' +info.oldKey, value ); //@TODO Check this for Int/Decimal - may need to treat value
    }
    SeLiteSettings.savePrefFile(); //@TODO Do we need this line?
    moduleSetFields[info.module.name][info.setName]= info.module.getFieldsOfSet( info.setName ); // not efficient, but robust: re-load the whole lot, rather than tweak it
    return true;
}

function createTreeView(original) {
    return {
        get rowCount() { return original.rowCount; },
        get selection() { return original.selection; },
        set selection(newValue) { return original.selection= newValue; },
        canDrop: function(index, orientation, dataTransfer) { return original.canDrop(index, orientation, dataTransfer); },
        cycleCell: function(row, col) { return original.cycleCell(row, col); },
        cycleHeader: function(col) { return original.cycleHeader(col); },
        drop: function(row, orientation, dataTransfer) { return original.drop(row, orientation, dataTransfer ); },
        getCellProperties: function(row, col) { return original.getCellProperties(row, col); },
        getCellText: function(row, col) { return original.getCellText(row, col); },
        getCellValue: function(row, col) { return original.getCellValue(row, col); },
        getColumnProperties: function(col, properties ) { return original.getColumnProperties(col, properties); },
        getImageSrc: function(row, col) { return original.getImageSrc(row, col); },
        getLevel: function(index) { return original.getLevel(index); },
        getParentIndex: function(rowIndex) { return original.getParentIndex(rowIndex); },
        getProgressMode: function(row ) { return original.getProgressMode(row); },
        getRowProperties: function(index) { return original.getRowProperties(index); },
        hasNextSibling: function(rowIndex, afterIndex) { return original.hasNextSibling(rowIndex, afterIndex); },
        isContainer: function(index) { return original.isContainer(index); },
        isContainerEmpty: function(index) { return original.isContainerEmpty(index); },
        isContainerOpen: function(index) { return original.isContainerOpen(index); },
        isEditable: function(row, col) { return original.isEditable(row, col); },
        isSelectable: function(row, col) { return original.isSelectable(row, col); },
        isSeparator: function(index) { return original.isSeparator(index); },
        isSorted: function() { return original.isSorted(); },
        performAction: function(action) { return original.performAction(action); },
        performActionOnCell: function(action, row, col) { return original.performActionOnCell(action, row, col); },
        performActionOnRow: function(action, row) { return original.performActionOnRow(action, row); },
        selectionChanged: function() { return original.selectionChanged(); },
        setCellText: function( row, col, value ) {
            // I have to pass original, rather than just original.setCellText as a parameter, because I couldn't invoke original.setCellText.call(null, parameters...).
            // It failed with: NS_NOINTERFACE: Component does not have requested interface [nsITreeView.setCellText]
            setCellText.call( null, row, col, value, original );
        },
        setCellValue: function(row, col, value) { return original.setCellValue(row, col, value); },
        setTree: function(tree) { return original.setTree(tree); },
        toggleOpenState: function(index) { return original.toggleOpenState(index); }
    };
}

/** Set/unset special value for the field in the preferences, if the change involves setting/unsetting a special value
 *  - that is, SeLiteSettings.VALUE_PRESENT or SeLiteSettings.NULL.
 *  Don't actually set/add/remove any actual value (other than a special value).
 *  Call this function before we set/add/remove the new value in preferences.
 *  @param setName string Name of the set; empty if the module doesn't allow multiple sets
 *  @param field Field instance
 *  @param int addOrRemove +1 if adding entry; -1 if removing it; any of 0/null/undefined if replacing or setting the whole field to null/undefined. It can be one of +1, -1 only if field.multivalued. If the field is an instance of SeLiteSettings.Field.FixedMap, then addOrRemove should be 0 when setting an *option* (value for fixedKey) of the field to null/undefined. Therefore you usually need 2 calls to this function when handling SeLiteSettings.Field.FixedMap - that keeps this function simple.
 *  @param {*} keyOrValue The new value to store, or (for Choice) the key for the new value to check.
 *  It can be anything (and is not used) if addOrRemove is +1 or -1, unless the field is an instance of SeLiteSettings.Field.FixedMap. Otherwise
 *  It should have been validated - this function doesn't validate keyOrValue.
 *  It can be null if it's a single-valued field.
 *  It can be undefined (then if it is multi-valued, the field is stored as VALUE_PRESENT).
 *  @param {string} [fixedKey] Only used, when setting an option (key) of SeLiteSettings.Field.FixedMap to null/undefined.
 *  But do not use when setting the whole value of a SeLiteSettings.Field.FixedMap field to undefined.
 * */
function updateSpecial( setName, field, addOrRemove, keyOrValue, fixedKey ) {
    !addOrRemove || field.multivalued || SeLiteMisc.fail("addOrRemove can be one of +1, -1 only if field.multivalued. addOrRemove is " +addOrRemove+ " and field.multivalued is " +field.multivalued);
    addOrRemove || keyOrValue!==null || !field.multivalued || field instanceof SeLiteSettings.Field.FixedMap
        || SeLiteMisc.fail("Field " +field.name+ " is multivalued, yet keyOrValue is null.");
    fixedKey===undefined || field instanceof SeLiteSettings.Field.FixedMap
        || SeLiteMisc.fail( 'fixedKey must be undefined, unless field is an instance of SeLiteSettings.Field.FixedMap.');
    var setNameDot= setName
        ? setName+'.'
        : setName;
    var compound= moduleSetFields[field.module.name][setName][field.name];
    try {
    if( addOrRemove ) {
        if( addOrRemove>0 ) {
            if( compound.entry!==undefined && Object.keys(compound.entry).length===0 && field.module.prefsBranch.prefHasUserValue(setNameDot+field.name) ) {
                field.module.prefsBranch.clearUserPref( setNameDot+field.name); // Clearing VALUE_PRESENT
            }
        }
        else {
            if( Object.keys(compound.entry).length===1 ) {
                field.module.prefsBranch.setCharPref( setNameDot+ field.name, SeLiteSettings.VALUE_PRESENT );
            }
        }
    }
    else {
        if( keyOrValue===null ) {
            if( fixedKey!==undefined && field instanceof SeLiteSettings.Field.FixedMap ) {
                field.module.prefsBranch.setCharPref( setNameDot+field.name+ '.' +fixedKey, SeLiteSettings.NULL );
            }
            else {
                if( field instanceof SeLiteSettings.Field.Choice && compound.entry!==undefined && Object.keys(compound.entry).length>0 ) {
                    !field.multivalued && Object.keys(compound.entry).length===1 || SeLiteMisc.fail();
                    field.module.prefsBranch.clearUserPref( setNameDot+field.name+ '.' +Object.keys(compound.entry)[0] );
                }
                if( field.module.prefsBranch.prefHasUserValue(setNameDot+field.name) && field.prefType()!==nsIPrefBranch.PREF_STRING ) {
                    field.module.prefsBranch.clearUserPref( setNameDot+field.name);
                }
                field.module.prefsBranch.setCharPref( setNameDot+field.name, SeLiteSettings.NULL );
            }
        }
        else
        if( keyOrValue===undefined ) {
            if( fixedKey!==undefined && field instanceof SeLiteSettings.Field.FixedMap ) {
                if( field.module.prefsBranch.prefHasUserValue(setNameDot+field.name+ '.' +fixedKey) ) {
                    field.module.prefsBranch.clearUserPref( setNameDot+field.name+ '.' +fixedKey );
                }
            }
            else {
                !field.multivalued || compound.entry!==undefined && Object.keys(compound.entry).length===0 || SeLiteMisc.fail("Multivalued field " +field.name+ " has one or more entries, therefore keyOrValue must not be undefined.");
                if( field.module.prefsBranch.prefHasUserValue(setNameDot+field.name) ) {
                    field.module.prefsBranch.clearUserPref(setNameDot+field.name);
                }
            }
        }
        else 
        if( field instanceof SeLiteSettings.Field.Choice && compound.entry===null ) {
            !field.multivalued || SeLiteMisc.fail();
            if( field.module.prefsBranch.prefHasUserValue(setNameDot+field.name) ) {
                field.module.prefsBranch.clearUserPref(setNameDot+field.name); // Clearing NULL
            }
        }
        // Otherwise, if the field had NULL, then I don't clear that preference here, because that preference gets set outside of this function
    }
    } catch(e) {
        console.log( 'updateSpecial() Module ' +field.module.name+ ', set ' +setName+ ', field: ' +field.name+ ' has compound: ' +typeof compound );
        SeLiteMisc.fail(e);
    }
}

/* @var allowSets bool Whether to show the column for selection of a set. If we're only showing one module and we're not showing fields per folder,
 * then this allowSets is same as module.allowSets.
 *  If we're showing more modules, then it's true if at least one of those modules has allowSets==true and we're not showing fields per folder.
 *  This will be set depending on the definition of module(s).
*/
var allowSets= false;
/** @var allowMultivaluedNonChoices bool Whether we allow multivalued non-choice (free text) fields.
 *  If allowMultivaluedNonChoices or allowSets, then we show 'Action' column.
 *  This will be set depending on the definition of module(s).
 */
var allowMultivaluedNonChoices= false;

/** @var mixed Null if we're showing configuration set(s) irrelevant of a folder. Otherwise it's 
 *  a string, absolute path to the folder we're applying the overall configuration.
 *  This will be set depending on how this file is invoked.
 * */
var targetFolder= null;
/** Shortcut function. Only valid once I set variable targetFolder.
 *  @return {bool}
 * */
function showingPerFolder() { return targetFolder!==null; }

/** Create an object for a new <treechildren>. Add it to the parent.
 *  @return XULElement for the new <treechildren>
 * */
function createTreeChildren( parent ) {
    if( !(parent instanceof XULElement)
    || parent.tagName!=='treeitem' && parent.tagName!=='tree' ) {
        throw new Error( 'createTreeChildren() requires parent to be an object for <treeitem> or <tree>.');
    }
    var treeChildren= document.createElementNS( XUL_NS, 'treechildren');
    if( parent.tagName!=='tree' ) {
        parent.setAttribute('container', 'true');
        parent.setAttribute('open', 'false');
    }
    parent.appendChild( treeChildren);
    return treeChildren;
}

/** Anonymous object serving as a multidimensional associative array {
 *      string module name: {
 *          string set name (possibly empty): result of Module.getFieldsOfSet();
 *      }
        It's only populated, updated and used in set mode; not in per-folder mode.
 *      Purpose: setCellText() uses it to determine whether in a single-valued string field
 *      'undefined' or 'null' are the actual values, or indicators of the field being undefined/null in that set.
 *      I also use it at some places that call nullOrUndefineLabel().
 *  }
 * */
var moduleSetFields= {};

window.addEventListener( "load", function(e) {
    var params= document.location.search.substring(1);
    if( document.location.search ) {
        if( /register/.exec( params ) ) {
            var result= {};
            if( promptService.select(
                window,
                'How to register or update a module definition',
                'You are about to register or update a Javascript definition of your configuration module. How would you enter it?',
                2,
                ['Locate as a local file', 'Enter a url'],
                result
            ) ) {
                var url= null;
                if( result.value===0 ) {
                    var file= chooseJavascriptFile();
                    if( file ) {
                        //var file= new FileUtils.File(fileName);
                        url= Services.io.newFileURI( file );
                    }
                }
                else {
                    var urlText= prompt( "Please enter the full URL to your Javascript file." );
                    if( urlText ) {
                        url= nsIIOService.newURI( urlText, null, null);
                    }
                }
                if( url ) {
                    console.log('loading settings definition from ' +url.spec );
                    subScriptLoader.loadSubScript(
                        url.spec,
                        {
                            SeLiteSettings: SeLiteSettings,
                            SELITE_SETTINGS_FILE_URL: url.spec
                        },
                        'UTF-8'
                    );
                    window.location.search= '';
                }
            }
            return;
        }
        var match= /folder=([^&]*)/.exec( params );
        if( match ) {
            targetFolder= unescape( match[1] );
        }
        var match= /module=([a-zA-Z0-9_.-]+)/.exec( params );
        var moduleName= null;
        if( match ) {
            moduleName= unescape( match[1] );
            try {
                modules[ moduleName ]= SeLiteSettings.loadFromJavascript( moduleName, undefined, true/** Force reload, so that user's changes has an effect without restarting Firefox. */ );
            }
            catch(e) {
                alert( "Couldn't load JS definnition of the requested module: " +e+ ':\n' +e.stack );
            }
            SeLiteMisc.ensure( !targetFolder || modules[moduleName].associatesWithFolders, "You're using URL with folder=" +targetFolder+
                " and module=" +moduleName+ ", however that module doesn't allow to be associated with folders." );
        }
        match= /prefix=([a-zA-Z0-9_.-]+)/.exec( params );
        var prefix= '';
        if( match ) {
            prefix= unescape( match[1] );
        }
        if( /selectFolder/.exec(params) ) {
            var newTargetFolder= chooseFileOrFolder( null, null, null, null, true/*isFolder*/, targetFolder );
            if( newTargetFolder ) {
                var newLocation= "?";
                if( moduleName ) {
                    newLocation+= "module=" +moduleName+ "&";
                }
                if( prefix ) {
                    newLocation+= "prefix="+prefix+ "&";
                }
                newLocation+= "folder=" +escape(newTargetFolder);
                document.location= newLocation;
            }
        }
    }
    var allowModules= false; // true if we list all modules (if any); false if we just list one named in URL parameter 'module' (if any)
    if( SeLiteMisc.isEmptyObject(modules) ) {
        allowModules= true;
        var moduleNames= SeLiteSettings.moduleNamesFromPreferences( prefix );
        var exceptionDetails= {};
        for( var i=0; i<moduleNames.length; i++ ) {
            var module;
            try {
                module= SeLiteSettings.loadFromJavascript( moduleNames[i], undefined, true/** Force reload, so that user's changes take effect without restarting Firefox. */ );
            }
            catch(e) {
                exceptionDetails[ moduleNames[i] ]= ''+ e+ ':\n' +e.stack;
            }

            if( !showingPerFolder() || module.associatesWithFolders ) {
                modules[ moduleNames[i] ]= module;
            }
        }
        if( Object.keys(exceptionDetails).length>0 ) {
            var msg= "Couldn't load JS definnition of configuration module(s):\n";
            for( var moduleName in exceptionDetails ) {
                msg+= moduleName+ ': ' +exceptionDetails[moduleName]+ '\n\n';
            }
            alert( msg );
        }
    }
    var tree= document.createElementNS( XUL_NS, 'tree' );
    tree.setAttribute( 'id', 'settingsTree');
    tree.setAttribute( 'editable', ''+!showingPerFolder() );
    tree.setAttribute( 'seltype', 'single' );
    tree.setAttribute( 'hidecolumnpicker', 'true');
    tree.setAttribute( 'hidevscroll', 'false');
    tree.setAttribute( 'class', 'tree');
    tree.setAttribute( 'onblur', 'onTreeBlur()' );
    tree.setAttribute( 'flex', '1');
    var settingsBox= document.getElementById('SeSettingsBox');
    settingsBox.appendChild( tree );
    
    for( var moduleName in modules ) {
        var module= modules[moduleName];
        allowSets= allowSets || module.allowSets && !showingPerFolder();
        
        for( var fieldName in module.fields ) {
            var field= module.fields[fieldName];
            allowMultivaluedNonChoices= allowMultivaluedNonChoices || field.multivalued && field instanceof SeLiteSettings.Field.Choice;
        }
    }
    tree.appendChild( generateTreeColumns(allowModules, showingPerFolder()) );
    var topTreeChildren= createTreeChildren( tree );
    
    var setNameToExpand= null;
    if( allowModules ) {
        for( var moduleName in modules ) {
            var moduleTreeItem= generateTreeItem( modules[moduleName], null, null, null, RowLevel.MODULE );
            topTreeChildren.appendChild( moduleTreeItem );
            
            var moduleChildren= createTreeChildren( moduleTreeItem );
            generateSets( moduleChildren, modules[moduleName] );
        }
    }
    else
    if( !SeLiteMisc.isEmptyObject(modules) ) {
        for( var moduleName in modules ); // just get moduleName
        
        var moduleChildren;
        if( allowSets && modules[moduleName].allowSets ) {
            var moduleTreeItem= generateTreeItem( modules[moduleName], null, null, null, RowLevel.MODULE );
            topTreeChildren.appendChild( moduleTreeItem );
            moduleChildren= createTreeChildren( moduleTreeItem );
        }
        else {
            moduleChildren= topTreeChildren;
        }
        if( document.location.search ) {
            var match= /set=([a-zA-Z0-9_.-]+)/.exec( params );
            if( match ) {
                setNameToExpand= unescape( match[1] );
            }
        }
        generateSets( moduleChildren, modules[moduleName] );
        tree.view.toggleOpenState(0); // expand the module, because it's the only one shown
    }
    topTreeChildren.addEventListener( 'click', treeClickHandler );
    tree.view= createTreeView( tree.view );
    if( setNameToExpand ) {
        var setIndex= module.setNames().indexOf(setNameToExpand);
        if( setIndex>=0 ) {
            tree.view.toggleOpenState( setIndex+1 ); // expand the set
        }
    }
}, false);

/** @return nsIFile instance for a javascript file, if picked; null if none.
 * */
function chooseJavascriptFile() {
	var filePicker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
	filePicker.init(window, "Select a Javascript file with definition of your module(s)", nsIFilePicker.modeOpen);
    filePicker.appendFilter( 'Javascript', '*.js');
    filePicker.appendFilters( nsIFilePicker.filterAll);
	var result= filePicker.show();
	if( result===nsIFilePicker.returnOK || result===nsIFilePicker.returnReplace ) {
		return filePicker.file;
	}
    return null;
}
/*
var seLiteSettingsMenuItem= document.createElementNS( XUL_NS, 'menuitem' );
seLiteSettingsMenuItem.setAttribute( 'label', 'SeLiteSettings module(s)' );
seLiteSettingsMenuItem.setAttribute( 'oncommand', 'window.editor.showInBrowser("chrome://selite-settings/content/tree.xul")' );
seLiteSettingsMenuItem.setAttribute( 'accesskey', 'S' );
var optionsPopup= document.getElementById('options-popup');
optionsPopup.appendChild(seLiteSettingsMenuItem);
/**/