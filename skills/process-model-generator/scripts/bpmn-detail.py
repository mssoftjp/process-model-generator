#!/usr/bin/env python3
"""Extract original semantic scopes for a complete, single-sheet diagram.
Scope boundaries come from BPMN containers, never from canvas dimensions.
"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('converter', Path(__file__).with_name('bpmn2flow.py'))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)
B, DI = converter.B, converter.DI
CONTAINERS = {B + x for x in ('subProcess', 'transaction', 'adHocSubProcess')}

def extract(src, directory, source_url):
    root = ET.parse(src).getroot()
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    scopes = [e for e in root.iter() if e.tag in CONTAINERS and any(c.tag == B+'sequenceFlow' for c in e)]
    parent = {c: p for p in root.iter() for c in p}
    metadata = []
    for el in root.iter():
        if el.tag == B+'extensionElements' and len(el):
            owner = parent[el]
            metadata.append(dict(owner=owner.get('id'), label=owner.get('name') or owner.get('id'), kind='elements', xml=ET.tostring(el, encoding='unicode'), lines=[converter.local(c.tag) + (' | ' + ', '.join(f'{converter.local(k)}: {v}' for k,v in c.attrib.items()) if c.attrib else '') + (': ' + ' '.join(c.text.split()) if c.text and c.text.strip() else '') for c in el.iter() if c is not el]))
        if el.tag.startswith(B):
            for attr, value in el.attrib.items():
                if attr.startswith('{') and not attr.startswith('{http://www.w3.org/2001/XMLSchema-instance}'):
                    metadata.append(dict(owner=el.get('id'), label=el.get('name') or el.get('id'), kind='attribute', name=attr, value=value))
    views = []
    represented = []
    for i, scope in enumerate([None] + scopes):
        model = copy.deepcopy(root)
        if scope is not None:
            for child in list(model):
                if child.tag in (B+'process', B+'collaboration'):
                    model.remove(child)
            process = copy.deepcopy(scope)
            process.tag = B+'process'
            model.insert(0, process)
        # Each child retains its activity and markers; its internal graph is rendered
        # once in its own named scope on the same output sheet.
        for el in model.iter():
            if el.tag in CONTAINERS:
                for child in list(el):
                    if child.tag in {B+x for x in converter.FLOW_NODE_TAGS} or child.tag in {B+'sequenceFlow', B+'laneSet', B+'dataObject', B+'dataObjectReference', B+'association', B+'textAnnotation'}:
                        el.remove(child)
            if el.tag == DI+'BPMNShape' and el.get('bpmnElement') in {s.get('id') for s in scopes}:
                el.set('isExpanded', 'false')
        for el in model.iter():
            for child in list(el):
                if child.tag == B+'extensionElements': el.remove(child)
            for attr in list(el.attrib):
                if attr.startswith('{') and not attr.startswith('{http://www.w3.org/2001/XMLSchema-instance}'):
                    del el.attrib[attr]
        xml = directory / f'scope-{i}.bpmn'
        flow = directory / f'scope-{i}.flow'
        ET.ElementTree(model).write(xml, encoding='utf-8', xml_declaration=True)
        stats = converter.main(str(xml), str(flow), source_url)
        represented.extend(item['id'] for item in stats['supported'] if item['tag'] != 'process-lane')
        owner = parent.get(scope) if scope is not None else None
        views.append(dict(id=scope.get('id') if scope is not None else 'root', parent=owner.get('id') if owner is not None else None,
                          label=(scope.get('name') or scope.get('id')) if scope is not None else 'Whole process', file=flow.name, unsupported=stats['unsupported'], edges=[dict(fromId=stats['nodeIds'].get(e.get('sourceRef')), toId=stats['nodeIds'].get(e.get('targetRef')), label=converter.clean(e.get('name'))) for pr in model.findall(B+'process') for e in pr.findall(B+'sequenceFlow')]))
    required = [e.get('id') for e in root.iter() if e.tag in {B+x for x in converter.FLOW_NODE_TAGS} | {B+x for x in ('sequenceFlow','messageFlow','dataObject','dataObjectReference','dataStoreReference','dataInput','dataOutput','association','textAnnotation')}]
    missing = [eid for eid in required if eid not in represented]
    result = dict(views=views, metadata=metadata, required=required, missing=missing, complete=not missing and not any(v['unsupported'] for v in views))
    (directory/'detail.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result

if __name__ == '__main__':
    extract(*sys.argv[1:4])
